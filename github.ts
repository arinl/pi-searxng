import { execFile } from "node:child_process";
import { extractHeadings } from "./extract.js";

const TIMEOUT = 15000;
const MAX_SIZE = 5 * 1024 * 1024;
const RAW_HOST = "https://raw.githubusercontent.com";
const API_HOST = "https://api.github.com";
const UA = "pi-searxng-fetch";

export interface GitHubResult {
  url: string;
  title: string;
  content: string;
  error?: string;
  via?: "raw" | "api" | "gh" | "redirect";
  command?: string;
}

interface GitHubUrlInfo {
  owner: string;
  repo: string;
  kind: "blob" | "tree" | "root" | "other";
  ref?: string;
  filePath?: string;
  refPathSegments?: string[];
}

export function isGitHubUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "github.com";
  } catch {
    return false;
  }
}

function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");

  if (segments.length === 2) return { owner, repo, kind: "root" };

  const marker = segments[2];
  if (marker === "blob" || marker === "tree") {
    const refPathSegments = segments.slice(3);
    return {
      owner,
      repo,
      kind: marker,
      ref: refPathSegments[0],
      filePath: refPathSegments.slice(1).join("/") || undefined,
      refPathSegments
    };
  }

  // pulls, issues, discussions, wiki, releases, actions, commits, ... — not handled here
  return { owner, repo, kind: "other" };
}

function isCommitSha(ref?: string): boolean {
  return !!ref && /^[0-9a-f]{7,40}$/i.test(ref);
}

// A blob/tree ref can contain slashes (e.g. `feature/my-branch`), so the
// ref/path boundary is ambiguous. Generate candidate splits, longest ref
// first, and let the caller probe each until one resolves.
function refCandidates(info: GitHubUrlInfo): Array<{ ref: string; filePath?: string }> {
  const segs = info.refPathSegments;
  if (!segs || segs.length === 0) {
    return info.ref ? [{ ref: info.ref, filePath: info.filePath }] : [];
  }
  if (segs.length === 1 || isCommitSha(segs[0])) {
    return [{ ref: segs[0], filePath: segs.slice(1).join("/") || undefined }];
  }
  const max = info.kind === "blob" ? segs.length - 1 : segs.length;
  const candidates: Array<{ ref: string; filePath?: string }> = [];
  for (let i = max; i >= 1; i--) {
    const ref = segs.slice(0, i).join("/");
    const filePath = segs.slice(i).join("/") || undefined;
    if (info.kind === "blob" && !filePath) continue;
    candidates.push({ ref, filePath });
  }
  return candidates;
}

// Keep slashes in branch/tag names unescaped — the GitHub API accepts them raw.
function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/gi, "/");
}

async function readTextWithLimit(res: Response, limit = MAX_SIZE): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > limit) throw new Error("Content too large");
    return text;
  }
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

async function safeGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { "User-Agent": UA, ...headers }
    });
    if (!res.ok) return { status: res.status, body: "" };
    return { status: 200, body: await readTextWithLimit(res) };
  } catch {
    return { status: 0, body: "" };
  }
}

interface GhResult {
  ok: boolean;
  stdout: string;
  notInstalled: boolean;
  notAuthed: boolean;
}

function runGh(args: string[]): Promise<GhResult> {
  return new Promise(resolve => {
    execFile("gh", args, { timeout: TIMEOUT, maxBuffer: MAX_SIZE }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return resolve({ ok: false, stdout: "", notInstalled: true, notAuthed: false });
      }
      const errText = (stderr || "") + (err?.message || "");
      const notAuthed = !!err && /HTTP 401|HTTP 403|authentication|gh auth login|not logged in/i.test(errText);
      resolve({ ok: !err, stdout: stdout || "", notInstalled: false, notAuthed });
    });
  });
}

// Memoized one-time check: is gh installed AND authenticated? Used only to
// decide ordering for the API-backed cases (tree/root) — authenticated gh gets
// 5000 req/hr vs 60/hr unauthenticated. Blob fetches stay raw-first regardless.
let ghUsableCache: Promise<boolean> | undefined;
function ghUsable(): Promise<boolean> {
  if (!ghUsableCache) {
    ghUsableCache = new Promise(resolve => {
      execFile("gh", ["auth", "status"], { timeout: TIMEOUT }, err => resolve(!err));
    });
  }
  return ghUsableCache;
}

function redirect(url: string, info: GitHubUrlInfo, why: "notInstalled" | "notAuthed"): GitHubResult {
  const reason = why === "notInstalled"
    ? "the `gh` CLI is not installed"
    : "the `gh` CLI is not authenticated";
  const lines = [
    `This looks like a private GitHub resource (public access returned 404) and ${reason}.`,
    ``,
    `To read it, either:`,
    why === "notInstalled"
      ? `- Install and authenticate the GitHub CLI (https://cli.github.com), then retry this fetch, or`
      : `- Authenticate the GitHub CLI with \`gh auth login\`, then retry this fetch, or`
  ];
  if (info.kind === "root") {
    lines.push(`- Clone it in your shell: git clone --depth 1 https://github.com/${info.owner}/${info.repo}.git`);
  } else {
    lines.push(
      `- Fetch it in your shell with git:`,
      `    git clone --depth 1 --filter=blob:none --sparse https://github.com/${info.owner}/${info.repo}.git`,
      `    cd ${info.repo} && git sparse-checkout set ${info.filePath ?? "<path>"}`
    );
  }
  return { url, title: `${info.owner}/${info.repo}`, content: lines.join("\n"), via: "redirect" };
}

function formatTree(body: string): string {
  try {
    const items = JSON.parse(body);
    if (!Array.isArray(items)) return body;
    const lines = items
      .map((it: { name?: string; type?: string }) => (it.name ? `- ${it.name}${it.type === "dir" ? "/" : ""}` : ""))
      .filter(Boolean);
    return lines.length ? lines.join("\n") : "Empty directory.";
  } catch {
    return body;
  }
}

async function fetchBlob(url: string, info: GitHubUrlInfo, headingsOnly: boolean): Promise<GitHubResult> {
  // Public files need no auth — probe raw.githubusercontent directly.
  for (const c of refCandidates(info)) {
    if (!c.filePath) continue;
    const rawUrl = `${RAW_HOST}/${info.owner}/${info.repo}/${c.ref}/${c.filePath}`;
    const r = await safeGet(rawUrl);
    if (r.status === 200) {
      return {
        url,
        title: c.filePath,
        content: headingsOnly ? extractHeadings(r.body) : r.body,
        via: "raw",
        command: rawUrl
      };
    }
  }
  // Not publicly reachable — fall back to authenticated gh.
  for (const c of refCandidates(info)) {
    if (!c.filePath) continue;
    const apiPath = `repos/${info.owner}/${info.repo}/contents/${c.filePath}?ref=${encodeRef(c.ref)}`;
    const gh = await runGh(["api", apiPath, "-H", "Accept: application/vnd.github.raw"]);
    if (gh.notInstalled) return redirect(url, info, "notInstalled");
    if (gh.notAuthed) return redirect(url, info, "notAuthed");
    if (gh.ok) {
      return {
        url,
        title: c.filePath,
        content: headingsOnly ? extractHeadings(gh.stdout) : gh.stdout,
        via: "gh",
        command: `gh api ${apiPath} -H "Accept: application/vnd.github.raw"`
      };
    }
  }
  return { url, title: "", content: "", error: "File not found on GitHub.", via: "gh" };
}

async function apiTree(url: string, info: GitHubUrlInfo): Promise<GitHubResult | null> {
  for (const c of refCandidates(info)) {
    const path = c.filePath ? `/${c.filePath}` : "";
    const apiPath = `repos/${info.owner}/${info.repo}/contents${path}?ref=${encodeRef(c.ref)}`;
    const r = await safeGet(`${API_HOST}/${apiPath}`, { Accept: "application/vnd.github+json" });
    if (r.status === 200) {
      return { url, title: `${info.owner}/${info.repo}${path}`, content: formatTree(r.body), via: "api", command: `${API_HOST}/${apiPath}` };
    }
    if (r.status === 403) break; // rate limited
  }
  return null;
}

async function ghTree(url: string, info: GitHubUrlInfo): Promise<GitHubResult> {
  for (const c of refCandidates(info)) {
    const path = c.filePath ? `/${c.filePath}` : "";
    const apiPath = `repos/${info.owner}/${info.repo}/contents${path}?ref=${encodeRef(c.ref)}`;
    const gh = await runGh(["api", apiPath]);
    if (gh.notInstalled) return redirect(url, info, "notInstalled");
    if (gh.notAuthed) return redirect(url, info, "notAuthed");
    if (gh.ok) {
      return { url, title: `${info.owner}/${info.repo}${path}`, content: formatTree(gh.stdout), via: "gh", command: `gh api ${apiPath}` };
    }
  }
  return { url, title: "", content: "", error: "Directory not found on GitHub.", via: "gh" };
}

// Prefer authenticated gh when available (higher rate limit); otherwise hit the
// unauthenticated API and fall back to gh (which yields the redirect) on failure.
async function fetchTree(url: string, info: GitHubUrlInfo): Promise<GitHubResult> {
  if (await ghUsable()) return ghTree(url, info);
  return (await apiTree(url, info)) ?? ghTree(url, info);
}

async function apiRoot(url: string, info: GitHubUrlInfo): Promise<GitHubResult | null> {
  const apiPath = `repos/${info.owner}/${info.repo}/readme`;
  const r = await safeGet(`${API_HOST}/${apiPath}`, { Accept: "application/vnd.github.raw" });
  if (r.status === 200) {
    return { url, title: `${info.owner}/${info.repo}`, content: r.body, via: "api", command: `${API_HOST}/${apiPath}` };
  }
  return null;
}

async function ghRoot(url: string, info: GitHubUrlInfo): Promise<GitHubResult> {
  const apiPath = `repos/${info.owner}/${info.repo}/readme`;
  const gh = await runGh(["api", apiPath, "-H", "Accept: application/vnd.github.raw"]);
  if (gh.notInstalled) return redirect(url, info, "notInstalled");
  if (gh.notAuthed) return redirect(url, info, "notAuthed");
  if (gh.ok) {
    return { url, title: `${info.owner}/${info.repo}`, content: gh.stdout, via: "gh", command: `gh api ${apiPath} -H "Accept: application/vnd.github.raw"` };
  }
  return { url, title: "", content: "", error: "No README found for this repository.", via: "gh" };
}

async function fetchRoot(url: string, info: GitHubUrlInfo): Promise<GitHubResult> {
  if (await ghUsable()) return ghRoot(url, info);
  return (await apiRoot(url, info)) ?? ghRoot(url, info);
}

// Returns null when the URL should fall through to the generic HTML fetch
// (non-repo paths, issues, PRs, wiki, discussions, etc.).
export async function fetchGitHub(url: string, opts: { headingsOnly?: boolean } = {}): Promise<GitHubResult | null> {
  const info = parseGitHubUrl(url);
  if (!info || info.kind === "other") return null;

  if (info.kind === "blob") return fetchBlob(url, info, !!opts.headingsOnly);
  if (info.kind === "tree") return fetchTree(url, info);
  return fetchRoot(url, info);
}
