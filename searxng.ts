import { loadConfig } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  score: number;
  publishedDate?: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface SearchOptions {
  limit?: number;
  pageno?: number;
  time_range?: "day" | "month" | "year";
  language?: string;
  categories?: string;
  engines?: string;
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
  if (opts.categories) {
    url.searchParams.set("categories", opts.categories);
  }
  if (opts.engines) {
    url.searchParams.set("engines", opts.engines);
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      "Accept": "application/json",
      "User-Agent": "pi-searxng/1.0"
    }
  });

  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

  const data = await res.json();

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of data.results || []) {
    if (results.length >= (opts.limit || config.maxResults)) break;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    results.push({
      title: r.title || "Untitled",
      url: r.url,
      snippet: r.content || r.abstract || "",
      score: r.score || 0,
      publishedDate: r.publishedDate || undefined
    });
  }

  return { results };
}
