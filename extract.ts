import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

const DEFAULT_TIMEOUT = 30000;
const MAX_SIZE = 5 * 1024 * 1024;
const CACHE_TTL = 60_000;

// ── URL cache ──────────────────────────────────────────
const urlCache = new Map<string, { content: ExtractedContent; ts: number }>();

function getCached(url: string): ExtractedContent | null {
  const entry = urlCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    urlCache.delete(url);
    return null;
  }
  return entry.content;
}

function setCache(url: string, content: ExtractedContent): void {
  urlCache.set(url, { content, ts: Date.now() });
}

// ── Headings extraction ────────────────────────────────
export function extractHeadings(markdown: string): string {
  const headings = markdown.split("\n").filter(l => /^#{1,6}\s/.test(l));
  return headings.length > 0 ? headings.join("\n") : "No headings found.";
}

// ── Types ──────────────────────────────────────────────
export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error?: string;
}

export interface FetchOptions {
  headingsOnly?: boolean;
}

// ── Main fetch ─────────────────────────────────────────
export async function fetchContent(url: string, opts: FetchOptions = {}): Promise<ExtractedContent> {
  const cached = getCached(url);
  if (cached) {
    if (opts.headingsOnly) {
      return { ...cached, content: extractHeadings(cached.content) };
    }
    return cached;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      return { url, title: "", content: "", error: `HTTP ${res.status}` };
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return { url, title: "", content: "", error: "Content too large" };
    }

    const html = await res.text();
    const { document } = parseHTML(html);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) {
      return { url, title: "", content: "", error: "Could not extract content" };
    }

    const extracted: ExtractedContent = {
      url,
      title: article.title || url,
      content: turndown.turndown(article.content)
    };

    setCache(url, extracted);

    if (opts.headingsOnly) {
      return { ...extracted, content: extractHeadings(extracted.content) };
    }
    return extracted;
  } catch (err) {
    return {
      url,
      title: "",
      content: "",
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}
