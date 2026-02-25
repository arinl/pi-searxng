import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "searxng.json");

export interface Config {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
}

export function loadConfig(): Config {
  const defaults: Config = {
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
    timeoutMs: 30000,
    maxResults: 10
  };
  
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...defaults, ...raw };
    }
  } catch {}
  
  return defaults;
}
