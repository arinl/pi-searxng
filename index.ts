import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { LRUCache } from "lru-cache";
import { search, type SearchResult } from "./searxng.js";
import { fetchContent } from "./extract.js";
import { isGitHubUrl, fetchGitHub } from "./github.js";

const SEARCH_CACHE_MAX = 20;
const TRUNCATE_LIMIT = 30000;

type Details = Record<string, unknown>;

// Subset of detail fields the render callbacks read back off a result.
interface RenderDetails {
  via?: string;
  command?: string;
  length?: number;
  truncated?: boolean;
  resultCount?: number;
}

const searchCache = new LRUCache<string, { query: string; results: SearchResult[] }>({
  max: SEARCH_CACHE_MAX
});

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function truncate(text: string, max = TRUNCATE_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "\n\n[Content truncated...]", truncated: true };
}

// Shared tool-result builders. Every tool returns the same { content, details } shape.
function textResult(text: string, details?: Details) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(err: unknown, extra?: Details) {
  const message = err instanceof Error ? err.message : String(err);
  return textResult(`Error: ${message}`, { error: message, ...extra });
}

// Truncate long content and record its size alongside the caller's details.
function contentResult(content: string, details: Details) {
  const { text, truncated } = truncate(content);
  return textResult(text, { ...details, truncated, length: content.length });
}

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => {
    const score = r.score ? ` (${r.score.toFixed(2)})` : "";
    const date = r.publishedDate ? ` · ${r.publishedDate}` : "";
    return `${i + 1}. **${r.title}**${score}${date}\n   ${r.url}\n   ${r.snippet.slice(0, 400)}${r.snippet.length > 400 ? "..." : ""}`;
  }).join("\n\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using SearXNG. Supports time filtering, pagination, and language selection.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results", default: 10 })),
      pageno: Type.Optional(Type.Number({ description: "Page number (starts at 1)", default: 1 })),
      time_range: Type.Optional(Type.Union([
        Type.Literal("day"),
        Type.Literal("month"),
        Type.Literal("year")
      ], { description: "Filter results by time range" })),
      language: Type.Optional(Type.String({ description: "Language code (e.g. 'en', 'fr'). Default: all" })),
      categories: Type.Optional(Type.String({ description: "SearXNG categories: general, news, science, it, files, social media" })),
      engines: Type.Optional(Type.String({ description: "Comma-separated engines (e.g. 'google,wikipedia,stackoverflow')" }))
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) return textResult("Aborted");

      try {
        const { results } = await search(params.query, params);
        const searchId = generateId();
        searchCache.set(searchId, { query: params.query, results });

        return textResult(formatSearchResults(results), {
          searchId,
          resultCount: results.length,
          query: params.query
        });
      } catch (err) {
        return errorResult(err);
      }
    },

    renderCall(args, theme) {
      const q = args.query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(theme.fg("toolTitle", "search ") + theme.fg("accent", `"${display}"`), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const count = (result.details as RenderDetails | undefined)?.resultCount || 0;
      return new Text(theme.fg("success", `${count} results`), 0, 0);
    }
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch a URL and return its content as markdown (HTML pages are converted via Readability). GitHub file, directory, and repo URLs are resolved to their content automatically. Use headingsOnly to scout long pages.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      headingsOnly: Type.Optional(Type.Boolean({ description: "Return only headings (useful for scouting long pages)", default: false }))
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) return textResult("Aborted");

      if (isGitHubUrl(params.url)) {
        const gh = await fetchGitHub(params.url, { headingsOnly: params.headingsOnly });
        if (gh) {
          if (gh.error) return errorResult(gh.error, { via: gh.via });
          return contentResult(gh.content, { title: gh.title, url: gh.url, via: gh.via, command: gh.command });
        }
        // gh === null → not a content URL (issue/PR/wiki/etc.), fall through to generic fetch
      }

      const result = await fetchContent(params.url, { headingsOnly: params.headingsOnly });
      if (result.error) return errorResult(result.error);

      return contentResult(result.content, { title: result.title, url: result.url });
    },

    renderCall(args, theme) {
      const url = args.url || "";
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      return new Text(theme.fg("toolTitle", "fetch ") + theme.fg("accent", display), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as RenderDetails | undefined;
      if (details?.via === "redirect") {
        return new Text(theme.fg("warning", "needs gh or git"), 0, 0);
      }
      const length = details?.length || 0;
      const cmd = details?.command ? (details.command.length > 60 ? details.command.slice(0, 57) + "..." : details.command) : "";
      const via = details?.via ? theme.fg("muted", ` via ${cmd || details.via}`) : "";
      return new Text(theme.fg("success", `${length} chars`) + (details?.truncated ? theme.fg("warning", " [truncated]") : "") + via, 0, 0);
    }
  });

  pi.registerTool({
    name: "get_search_results",
    label: "Get Search Results",
    description: "Retrieve previous search results by ID",
    parameters: Type.Object({
      searchId: Type.String()
    }),

    async execute(_id, params) {
      const cached = searchCache.get(params.searchId);
      if (!cached) return textResult("Search not found");
      return textResult(`Query: "${cached.query}"\n\n${formatSearchResults(cached.results)}`);
    }
  });
}
