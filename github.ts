import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const CLONE_TIMEOUT = 60000;
const MAX_FILES = 100;

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

export interface RawFile {
  path: string;
  content: string;
  url: string;
}

export interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string;
  type?: "blob" | "tree";
  filePath?: string;
}

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
    if (segments.length >= 4 && (segments[2] === "blob" || segments[2] === "tree")) {
      type = segments[2] as "blob" | "tree";
      ref = segments[3];
      if (segments.length > 4) {
        filePath = segments.slice(4).join("/");
      }
    }

    return { owner, repo, ref, type, filePath };
  } catch {
    return null;
  }
}

export function isGitHubUrl(url: string): boolean {
  if (url.includes("gist.github.com")) return false;
  return url.includes("github.com") &&
    /github\.com\/[^/]+\/[^/]+/.test(url);
}

export async function fetchRawFile(info: GitHubUrlInfo): Promise<RawFile | null> {
  if (!info.filePath || !info.ref) return null;

  const rawUrl = `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${info.ref}/${info.filePath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "pi-searxng/1.0" }
    });

    if (!res.ok) return null;

    const content = await res.text();
    return { path: info.filePath, content, url: rawUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function cloneRepo(info: GitHubUrlInfo): Promise<ClonedRepo | null> {
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
    return { localPath: cloneDir, files };
  } catch {
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
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
