import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { search } from "./searxng.js";
import { fetchContent } from "./extract.js";
import { isGitHubUrl, fetchGitHub } from "./github.js";

const SEARCH_CACHE_MAX = 20;
const TRUNCATE_LIMIT = 30000;

const searchCache = new Map<string, { query: string; results: any[] }>();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function truncate(text: string, max = TRUNCATE_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + "\n\n[Content truncated...]", truncated: true };
}

function formatSearchResults(results: any[]): string {
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
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      try {
        const { results } = await search(params.query, params);
        const searchId = generateId();

        if (searchCache.size >= SEARCH_CACHE_MAX) {
          const oldest = searchCache.keys().next().value!;
          searchCache.delete(oldest);
        }
        searchCache.set(searchId, { query: params.query, results });

        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { searchId, resultCount: results.length, query: params.query }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: String(err) }
        };
      }
    },

    renderCall(args, theme) {
      const q = (args as any).query || "";
      const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
      return new Text(theme.fg("toolTitle", "search ") + theme.fg("accent", `"${display}"`), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const count = (result.details as any)?.resultCount || 0;
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
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      if (isGitHubUrl(params.url)) {
        const gh = await fetchGitHub(params.url, { headingsOnly: params.headingsOnly });
        if (gh) {
          if (gh.error) {
            return { content: [{ type: "text", text: `Error: ${gh.error}` }], details: { error: gh.error, via: gh.via } };
          }
          const { text, truncated } = truncate(gh.content);
          return {
            content: [{ type: "text", text }],
            details: { title: gh.title, url: gh.url, via: gh.via, command: gh.command, truncated, length: gh.content.length }
          };
        }
        // gh === null → not a content URL (issue/PR/wiki/etc.), fall through to generic fetch
      }

      const result = await fetchContent(params.url, { headingsOnly: params.headingsOnly });

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error }
        };
      }

      const { text, truncated } = truncate(result.content);

      return {
        content: [{ type: "text", text }],
        details: {
          title: result.title,
          url: result.url,
          truncated,
          length: result.content.length
        }
      };
    },

    renderCall(args, theme) {
      const url = (args as any).url || "";
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      return new Text(theme.fg("toolTitle", "fetch ") + theme.fg("accent", display), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
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
      if (!cached) {
        return { content: [{ type: "text", text: "Search not found" }] };
      }
      return {
        content: [{ type: "text", text: `Query: "${cached.query}"\n\n${formatSearchResults(cached.results)}` }]
      };
    }
  });
}
