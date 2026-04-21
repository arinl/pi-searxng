import { loadConfig } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface SearchOptions {
  limit?: number;
  pageno?: number;
  time_range?: "day" | "month" | "year";
  language?: string;
}

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const config = loadConfig();
  const url = new URL(`${config.searxngUrl}/search`);

  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");

  if (opts.pageno && opts.pageno > 1) {
    url.searchParams.set("pageno", opts.pageno.toString());
  }
  if (opts.time_range) {
    url.searchParams.set("time_range", opts.time_range);
  }
  if (opts.language && opts.language !== "all") {
    url.searchParams.set("language", opts.language);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "pi-searxng/1.0"
      }
    });

    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

    const data = await res.json();

    const results: SearchResult[] = (data.results || [])
      .slice(0, opts.limit || config.maxResults)
      .map((r: any) => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.content || r.abstract || "",
        score: r.score || 0
      }));

    return { results };
  } finally {
    clearTimeout(timeout);
  }
}
