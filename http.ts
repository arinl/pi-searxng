export const MAX_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

export interface FetchTextOptions {
  headers?: Record<string, string>;
  limit?: number;
  timeout?: number;
}

export interface FetchTextResult {
  status: number;
  body: string;
}

// Read a response body, aborting if it exceeds `limit` bytes.
export async function readTextWithLimit(res: Response, limit = MAX_SIZE): Promise<string> {
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

// Fetch a URL and return its status + body text. On a non-2xx response the body
// is empty. Throws on network error, timeout, or oversized content.
export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<FetchTextResult> {
  const limit = opts.limit ?? MAX_SIZE;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT),
    headers: { "User-Agent": DEFAULT_UA, ...opts.headers }
  });

  if (!res.ok) return { status: res.status, body: "" };

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new Error("Content too large");

  return { status: res.status, body: await readTextWithLimit(res, limit) };
}

export function formatContentType(contentType: string): string {
  return contentType.split(";")[0] || "unknown";
}

export function isTextLikeContentType(contentType: string): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/") ||
    normalized.includes("html") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript");
}

export function isHtmlContentType(contentType: string): boolean {
  const normalized = formatContentType(contentType).toLowerCase();
  return normalized === "text/html" || normalized === "application/xhtml+xml";
}
