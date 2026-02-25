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
  return url.includes("github.com") && 
    /github\.com\/[^/]+\/[^/]+/.test(url);
}

export async function cloneRepo(url: string): Promise<ClonedRepo | null> {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/);
  if (!match) return null;
  
  const [, owner, repo] = match;
  const repoName = repo.replace(/\.git$/, "");
  
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-gh-"));
  const cloneDir = join(tmpDir, repoName);
  
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["clone", "--depth", "1", url, cloneDir], {
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
