import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { search } from "./searxng.js";
import { fetchContent } from "./extract.js";
import { isGitHubUrl, cloneRepo } from "./github.js";

const searchCache = new Map<string, { query: string; results: any[] }>();

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatSearchResults(results: any[]): string {
  if (results.length === 0) return "No results found.";
  return results.map((r, i) => {
    const score = r.score ? ` (${r.score.toFixed(2)})` : "";
    return `${i + 1}. **${r.title}**${score}\n   ${r.url}\n   ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? "..." : ""}`;
  }).join("\n\n");
}

function formatRepoFiles(files: any[]): string {
  return files.slice(0, 30).map(f => `- ${f.path}`).join("\n") + 
    (files.length > 30 ? `\n... and ${files.length - 30} more files` : "");
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
      language: Type.Optional(Type.String({ description: "Language code (e.g. 'en', 'fr'). Default: all" }))
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      try {
        const { results } = await search(params.query, {
          limit: params.limit,
          pageno: params.pageno,
          time_range: params.time_range,
          language: params.language
        });
        const searchId = generateId();
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
    description: "Fetch URL content as markdown. Automatically clones GitHub repos. Use headingsOnly to scout a page before fetching full content.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      headingsOnly: Type.Optional(Type.Boolean({ description: "Return only headings (useful for scouting long pages)", default: false }))
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      if (isGitHubUrl(params.url)) {
        const repo = await cloneRepo(params.url);
        
        if (!repo) {
          return {
            content: [{ type: "text", text: "Failed to clone repository" }],
            details: { error: "Clone failed" }
          };
        }
        
        const output = `## Repository Cloned\n\n**Path:** \`${repo.localPath}\`\n\n**Files (${repo.files.length}):**\n${formatRepoFiles(repo.files)}\n\n---\n\nUse \`read\` tool to explore files.`;
        
        return {
          content: [{ type: "text", text: output }],
          details: { 
            localPath: repo.localPath, 
            fileCount: repo.files.length,
            files: repo.files.slice(0, 10).map(f => f.path)
          }
        };
      }

      const result = await fetchContent(params.url, { headingsOnly: params.headingsOnly });
      
      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error}` }],
          details: { error: result.error }
        };
      }
      
      const truncated = result.content.length > 30000;
      const content = truncated 
        ? result.content.slice(0, 30000) + "\n\n[Content truncated...]"
        : result.content;
      
      return {
        content: [{ type: "text", text: content }],
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
      const isGH = isGitHubUrl(url);
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      const prefix = isGH ? "clone " : "fetch ";
      const color = isGH ? "warning" : "accent";
      return new Text(theme.fg("toolTitle", prefix) + theme.fg(color, display), 0, 0);
    },
    
    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.localPath) {
        return new Text(theme.fg("success", `cloned`) + theme.fg("muted", ` ${details.fileCount} files`), 0, 0);
      }
      const length = details?.length || 0;
      return new Text(theme.fg("success", `${length} chars`) + (details?.truncated ? theme.fg("warning", " [truncated]") : ""), 0, 0);
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
