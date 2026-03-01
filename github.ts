import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const CLONE_TIMEOUT = 60000;
const MAX_SIZE_MB = 100;
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

export interface RepoFile {
  path: string;
  content: string;
}

export interface ClonedRepo {
  localPath: string;
  files: RepoFile[];
}

export function isGitHubUrl(url: string): boolean {
  // Exclude gist.github.com - let it fall through to regular content fetching
  if (url.includes("gist.github.com")) return false;
  return url.includes("github.com") &&
    /github\.com\/[^/]+\/[^/]+/.test(url);
}

interface GitHubUrlInfo {
  owner: string;
  repo: string;
  ref?: string; // branch/tag from blob/tree URLs
}

function parseGitHubUrl(url: string): GitHubUrlInfo | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;

    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, "");

    // Handle blob/tree URLs: github.com/owner/repo/blob/main/path/to/file
    let ref: string | undefined;
    if (segments.length >= 4 && (segments[2] === "blob" || segments[2] === "tree")) {
      ref = segments[3];
    }

    return { owner, repo, ref };
  } catch {
    return null;
  }
}

export async function cloneRepo(url: string): Promise<ClonedRepo | null> {
  const info = parseGitHubUrl(url);
  if (!info) return null;

  const { owner, repo, ref } = info;
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-gh-"));
  const cloneDir = join(tmpDir, repo);

  // Build clone URL and args
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
    
    const files = readDirRecursive(cloneDir, cloneDir);
    return { localPath: cloneDir, files };
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

function readDirRecursive(dir: string, baseDir: string, files: RepoFile[] = []): RepoFile[] {
  if (files.length >= MAX_FILES) return files;
  
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      readDirRecursive(fullPath, baseDir, files);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      
      try {
        const stats = statSync(fullPath);
        if (stats.size > 100 * 1024) continue;

        const content = readFileSync(fullPath, "utf-8");
        const relPath = fullPath.slice(baseDir.length + 1);
        files.push({ path: relPath, content });
      } catch {}
    }
  }
  
  return files;
}
