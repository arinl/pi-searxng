import { loadConfig } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
}

export async function search(query: string, limit?: number): Promise<SearchResponse> {
  const config = loadConfig();
  const url = new URL(`${config.searxngUrl}/search`);
  
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  
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
      .slice(0, limit || config.maxResults)
      .map((r: any) => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.content || r.abstract || ""
      }));
    
    return { results };
  } finally {
    clearTimeout(timeout);
  }
}
