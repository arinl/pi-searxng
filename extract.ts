import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { LRUCache } from "lru-cache";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

const DEFAULT_TIMEOUT = 30000;
const MAX_SIZE = 5 * 1024 * 1024;

type CacheMode = "full" | "headings";
type CachePayload = Partial<Record<CacheMode, ExtractedContent>>;

const urlCache = new LRUCache<string, CachePayload>({
  max: 50,
  ttl: 60_000
});

function getCached(url: string, mode: CacheMode): ExtractedContent | null {
  return urlCache.get(url)?.[mode] || null;
}

function setCache(url: string, payload: CachePayload): void {
  urlCache.set(url, { ...(urlCache.get(url) || {}), ...payload });
}

function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;

  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/") ||
    normalized.includes("html") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript");
}

function formatContentType(contentType: string): string {
  return contentType.split(";")[0] || "unknown";
}

function isHtmlContentType(contentType: string): boolean {
  const normalized = formatContentType(contentType).toLowerCase();
  return normalized === "text/html" || normalized === "application/xhtml+xml";
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

function extractDomHeadings(root: Document | Element | null): string {
  if (!root) return "No headings found.";

  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map(node => {
      const level = Number(node.tagName[1]);
      const text = node.textContent?.replace(/\s+/g, " ").trim();
      return text ? `${"#".repeat(level)} ${text}` : "";
    })
    .filter(Boolean);

  return headings.length > 0 ? headings.join("\n") : "No headings found.";
}

export function extractHeadings(markdown: string): string {
  const headings = markdown.split("\n").filter(l => /^#{1,6}\s/.test(l));
  return headings.length > 0 ? headings.join("\n") : "No headings found.";
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error?: string;
}

export interface FetchOptions {
  headingsOnly?: boolean;
}

export async function fetchContent(url: string, opts: FetchOptions = {}): Promise<ExtractedContent> {
  const mode: CacheMode = opts.headingsOnly ? "headings" : "full";
  const cached = getCached(url, mode);
  if (cached) return cached;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      return { url, title: "", content: "", error: `HTTP ${res.status}` };
    }

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_SIZE) {
      return { url, title: "", content: "", error: "Content too large" };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType && !isTextLikeContentType(contentType)) {
      return {
        url,
        title: "",
        content: "",
        error: `Unsupported content type: ${formatContentType(contentType)}`
      };
    }

    const body = await readTextWithLimit(res, MAX_SIZE);

    if (contentType.includes("json")) {
      const full: ExtractedContent = {
        url,
        title: url,
        content: "```json\n" + body + "\n```"
      };
      const headings: ExtractedContent = { url, title: url, content: "No headings found." };
      setCache(url, opts.headingsOnly ? { headings } : { full, headings });
      return opts.headingsOnly ? headings : full;
    }

    if (contentType && !isHtmlContentType(contentType)) {
      const full: ExtractedContent = { url, title: url, content: body };
      const headings: ExtractedContent = { url, title: url, content: extractHeadings(body) };
      setCache(url, opts.headingsOnly ? { headings } : { full, headings });
      return opts.headingsOnly ? headings : full;
    }

    const { document } = parseHTML(body);
    const title = document.querySelector("title")?.textContent || url;
    const root = document.querySelector("main, article") || document.body || document.documentElement;
    const headings: ExtractedContent = { url, title, content: extractDomHeadings(root) };

    if (opts.headingsOnly) {
      setCache(url, { headings });
      return headings;
    }

    const reader = new Readability(document);
    const article = reader.parse();

    let full: ExtractedContent;
    if (article) {
      full = {
        url,
        title: article.title || title,
        content: turndown.turndown(article.content)
      };
    } else {
      full = { url, title, content: turndown.turndown(body) };
    }

    setCache(url, { full, headings });
    return full;
  } catch (err) {
    return {
      url,
      title: "",
      content: "",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
