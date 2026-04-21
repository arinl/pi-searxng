import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { LRUCache } from "lru-cache";

const CLONE_TIMEOUT = 60000;
const LS_REMOTE_TIMEOUT = 15000;
const RAW_FETCH_TIMEOUT = 15000;
const API_TIMEOUT = 15000;
const MAX_RAW_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 100;
const GITHUB_API = "https://api.github.com";

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z",
  ".exe", ".dll", ".so", ".dylib", ".bin",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx"
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "__pycache__",
  ".venv", "venv", "dist", "build"
]);

export interface ClonedRepo {
  localPath: string;
  files: string[];
}

type CloneCacheEntry = {
  tmpDir: string;
  repo: ClonedRepo;
};

export interface RawFile {
  path: string;
  content: string;
  url: string;
  error?: string;
}

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  type?: "blob" | "tree";
  filePath?: string;
  refPathSegments?: string[];
}

const cloneCache = new LRUCache<string, CloneCacheEntry>({
  max: 8,
  ttl: 30 * 60_000,
  dispose: entry => {
    rmSync(entry.tmpDir, { recursive: true, force: true });
  }
});

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;

    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, "");

    let ref: string | undefined;
    let type: "blob" | "tree" | undefined;
    let filePath: string | undefined;
    let refPathSegments: string[] | undefined;
    if (segments.length >= 4 && (segments[2] === "blob" || segments[2] === "tree")) {
      type = segments[2] as "blob" | "tree";
      refPathSegments = segments.slice(3);
      ref = refPathSegments[0];
      if (refPathSegments.length > 1) {
        filePath = refPathSegments.slice(1).join("/");
      }
    }

    return { owner, repo, ref, type, filePath, refPathSegments };
  } catch {
    return null;
  }
}

export function isGitHubUrl(url: string): boolean {
  if (url.includes("gist.github.com")) return false;
  return url.includes("github.com") &&
    /github\.com\/[^/]+\/[^/]+/.test(url);
}

function isCommitSha(ref?: string): boolean {
  return !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
}

function isAmbiguousGitHubRef(info: GitHubUrlInfo): boolean {
  return !!info.type &&
    !!info.refPathSegments &&
    info.refPathSegments.length > 1 &&
    !isCommitSha(info.ref);
}

function getRefCandidates(info: GitHubUrlInfo): Array<{ ref: string; filePath?: string }> {
  if (!info.refPathSegments || info.refPathSegments.length === 0) {
    return info.ref ? [{ ref: info.ref, filePath: info.filePath }] : [];
  }

  const max = info.type === "blob" ? info.refPathSegments.length - 1 : info.refPathSegments.length;
  const candidates: Array<{ ref: string; filePath?: string }> = [];

  for (let i = max; i >= 1; i--) {
    const ref = info.refPathSegments.slice(0, i).join("/");
    const filePath = info.refPathSegments.slice(i).join("/") || undefined;
    if (info.type === "blob" && !filePath) continue;
    candidates.push({ ref, filePath });
  }

  return candidates;
}

async function listRemoteRefs(info: GitHubUrlInfo): Promise<Set<string>> {
  const cloneUrl = `https://github.com/${info.owner}/${info.repo}.git`;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("git", ["ls-remote", "--heads", "--tags", cloneUrl], {
        timeout: LS_REMOTE_TIMEOUT
      }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });

    const refs = new Set<string>();
    for (const line of stdout.split("\n")) {
      const ref = line.split("\t")[1];
      if (!ref) continue;
      if (ref.startsWith("refs/heads/")) {
        refs.add(ref.slice("refs/heads/".length));
      } else if (ref.startsWith("refs/tags/")) {
        refs.add(ref.slice("refs/tags/".length).replace(/\^\{\}$/, ""));
      }
    }

    return refs;
  } catch {
    return new Set();
  }
}

async function resolveGitHubRef(info: GitHubUrlInfo): Promise<GitHubUrlInfo> {
  const candidates = getRefCandidates(info);
  if (candidates.length === 0) return info;
  if (candidates.length === 1) return { ...info, ...candidates[0] };

  const refs = await listRemoteRefs(info);
  const match = candidates.find(candidate => refs.has(candidate.ref));
  return match ? { ...info, ...match } : info;
}

function isBinaryContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/") ||
    normalized.startsWith("font/") ||
    normalized.includes("application/pdf") ||
    normalized.includes("application/zip") ||
    normalized.includes("application/gzip") ||
    normalized.includes("application/x-gzip") ||
    normalized.includes("application/x-bzip2") ||
    normalized.includes("application/x-7z-compressed") ||
    normalized.includes("application/x-rar-compressed");
}

function formatContentType(contentType: string): string {
  return contentType.split(";")[0] || "unknown";
}

async function readTextWithLimit(res: Response, limit: number): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > limit) {
      throw new Error("Content too large");
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Content too large");
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function shouldRetryResolvedRef(info: GitHubUrlInfo, error?: string): boolean {
  return isAmbiguousGitHubRef(info) && !!error && error.startsWith("HTTP 404");
}

function isSameRefTarget(a: GitHubUrlInfo, b: GitHubUrlInfo): boolean {
  return a.ref === b.ref && a.filePath === b.filePath;
}

function getCloneCacheKey(info: GitHubUrlInfo): string {
  return `${info.owner}/${info.repo}@${info.ref || "HEAD"}`;
}

function getCachedClone(info: GitHubUrlInfo): ClonedRepo | null {
  const entry = cloneCache.get(getCloneCacheKey(info));
  if (!entry) return null;

  try {
    if (!statSync(entry.repo.localPath).isDirectory()) {
      cloneCache.delete(getCloneCacheKey(info));
      return null;
    }
  } catch {
    cloneCache.delete(getCloneCacheKey(info));
    return null;
  }

  return entry.repo;
}

function setCachedClone(info: GitHubUrlInfo, tmpDir: string, repo: ClonedRepo): void {
  cloneCache.set(getCloneCacheKey(info), { tmpDir, repo });
}

async function fetchRawFileAt(info: GitHubUrlInfo): Promise<RawFile | null> {
  if (!info.filePath || !info.ref) return null;

  const rawUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}/${info.filePath}`;
  if (BINARY_EXTS.has(extname(info.filePath).toLowerCase())) {
    return {
      path: info.filePath,
      content: "",
      url: rawUrl,
      error: "Binary files are not supported"
    };
  }

  try {
    const res = await fetch(rawUrl, {
      signal: AbortSignal.timeout(RAW_FETCH_TIMEOUT),
      headers: { "User-Agent": "pi-searxng/1.0" }
    });

    if (!res.ok) {
      return {
        path: info.filePath,
        content: "",
        url: rawUrl,
        error: `HTTP ${res.status}`
      };
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RAW_SIZE) {
      return {
        path: info.filePath,
        content: "",
        url: rawUrl,
        error: "Content too large"
      };
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType && isBinaryContentType(contentType)) {
      return {
        path: info.filePath,
        content: "",
        url: rawUrl,
        error: `Unsupported content type: ${formatContentType(contentType)}`
      };
    }

    const content = await readTextWithLimit(res, MAX_RAW_SIZE);
    return { path: info.filePath, content, url: rawUrl };
  } catch (err) {
    return {
      path: info.filePath,
      content: "",
      url: rawUrl,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function fetchRawFile(info: GitHubUrlInfo): Promise<RawFile | null> {
  const initial = await fetchRawFileAt(info);
  if (!initial || !shouldRetryResolvedRef(info, initial.error)) return initial;

  const resolved = await resolveGitHubRef(info);
  if (isSameRefTarget(resolved, info)) return initial;

  return await fetchRawFileAt(resolved) || initial;
}

async function cloneRepoAt(info: GitHubUrlInfo): Promise<ClonedRepo | null> {
  const cached = getCachedClone(info);
  if (cached) return cached;

  const { owner, repo, ref } = info;
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-gh-"));
  const cloneDir = join(tmpDir, repo);

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(cloneUrl, cloneDir);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile("git", args, {
        timeout: CLONE_TIMEOUT
      }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const files = collectPaths(cloneDir, cloneDir);
    const clonedRepo = { localPath: cloneDir, files };
    setCachedClone(info, tmpDir, clonedRepo);
    return clonedRepo;
  } catch {
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

export async function cloneRepo(info: GitHubUrlInfo): Promise<ClonedRepo | null> {
  const initial = await cloneRepoAt(info);
  if (initial || !isAmbiguousGitHubRef(info)) return initial;

  const resolved = await resolveGitHubRef(info);
  if (isSameRefTarget(resolved, info)) return initial;

  return await cloneRepoAt(resolved);
}

export interface RepoMetadata {
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  stars: number;
  language: string | null;
  topics: string[];
  license: string | null;
  homepage: string | null;
  url: string;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
}

export interface RepoOverview {
  metadata: RepoMetadata;
  readme: string | null;
  entries: TreeEntry[];
  ref: string;
}

async function githubApi<T>(path: string, opts: { raw?: boolean } = {}): Promise<T | null> {
  const headers: Record<string, string> = {
    "User-Agent": "pi-searxng/1.0",
    "Accept": opts.raw ? "application/vnd.github.raw" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      signal: AbortSignal.timeout(API_TIMEOUT),
      headers
    });
    if (!res.ok) return null;
    return opts.raw ? ((await res.text()) as any) : await res.json();
  } catch {
    return null;
  }
}

export async function fetchRepoMetadata(info: GitHubUrlInfo): Promise<RepoMetadata | null> {
  const data = await githubApi<any>(`/repos/${info.owner}/${info.repo}`);
  if (!data) return null;
  return {
    name: data.name,
    fullName: data.full_name,
    description: data.description,
    defaultBranch: data.default_branch,
    stars: data.stargazers_count || 0,
    language: data.language,
    topics: data.topics || [],
    license: data.license?.spdx_id || null,
    homepage: data.homepage || null,
    url: data.html_url
  };
}

export async function fetchReadme(info: GitHubUrlInfo, ref?: string): Promise<string | null> {
  const path = `/repos/${info.owner}/${info.repo}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  return await githubApi<string>(path, { raw: true });
}

export async function fetchTreeContents(info: GitHubUrlInfo, subPath: string = "", ref?: string): Promise<TreeEntry[] | null> {
  const clean = subPath.replace(/^\/+|\/+$/g, "");
  const path = `/repos/${info.owner}/${info.repo}/contents/${clean}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const data = await githubApi<any>(path);
  if (!Array.isArray(data)) return null;
  return data.map((item: any) => ({
    path: item.path,
    name: item.name,
    type: item.type === "dir" ? "dir" : "file",
    size: item.size
  }));
}

export async function describeRepo(info: GitHubUrlInfo): Promise<RepoOverview | null> {
  const metadata = await fetchRepoMetadata(info);
  if (!metadata) return null;

  const ref = info.ref || metadata.defaultBranch;
  const [readme, entries] = await Promise.all([
    fetchReadme(info, ref),
    fetchTreeContents(info, "", ref)
  ]);

  return {
    metadata,
    readme,
    entries: entries || [],
    ref
  };
}

function collectPaths(dir: string, baseDir: string, paths: string[] = []): string[] {
  if (paths.length >= MAX_FILES) return paths;

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (paths.length >= MAX_FILES) break;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      collectPaths(fullPath, baseDir, paths);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;

      try {
        const stats = statSync(fullPath);
        if (stats.size > 100 * 1024) continue;
        paths.push(fullPath.slice(baseDir.length + 1));
      } catch {}
    }
  }

  return paths;
}
