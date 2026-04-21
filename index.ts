import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { search } from "./searxng.js";
import { fetchContent } from "./extract.js";
import {
  isGitHubUrl,
  parseGitHubUrl,
  fetchRawFile,
  cloneRepo,
  describeRepo,
  fetchTreeContents,
  type RepoOverview,
  type TreeEntry
} from "./github.js";

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

function formatRepoFiles(files: string[]): string {
  return files.slice(0, 30).map(f => `- ${f}`).join("\n") +
    (files.length > 30 ? `\n... and ${files.length - 30} more files` : "");
}

function formatTreeEntries(entries: TreeEntry[]): string {
  if (entries.length === 0) return "_(empty)_";
  return entries
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
    .map(e => `- ${e.type === "dir" ? `**${e.name}/**` : e.name}`)
    .join("\n");
}

function formatRepoOverview(overview: RepoOverview): string {
  const m = overview.metadata;
  const meta = [
    `# ${m.fullName}`,
    m.description ? `\n${m.description}` : "",
    "",
    `- **Default branch:** \`${m.defaultBranch}\``,
    `- **Stars:** ${m.stars.toLocaleString()}`,
    m.language ? `- **Language:** ${m.language}` : null,
    m.license ? `- **License:** ${m.license}` : null,
    m.topics.length ? `- **Topics:** ${m.topics.join(", ")}` : null,
    m.homepage ? `- **Homepage:** ${m.homepage}` : null,
    `- **URL:** ${m.url}`
  ].filter(Boolean).join("\n");

  const filesBlock = `## Files (at \`${overview.ref}\`)\n\n${formatTreeEntries(overview.entries)}`;

  const readmeBlock = overview.readme
    ? `## README\n\n${overview.readme}`
    : "## README\n\n_(no README found)_";

  return [meta, "", filesBlock, "", readmeBlock].join("\n");
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
    description: "Fetch URL content as markdown. For GitHub URLs, returns metadata + README + file listing (repo root), directory contents (tree URLs), or the raw file (blob URLs) — all via the GitHub API, no clone. Use clone_repo when you need local filesystem access for deeper exploration. Use headingsOnly to scout long pages.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      headingsOnly: Type.Optional(Type.Boolean({ description: "Return only headings (useful for scouting long pages)", default: false }))
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      const ghInfo = isGitHubUrl(params.url) ? parseGitHubUrl(params.url) : null;

      if (ghInfo?.type === "blob" && ghInfo.filePath) {
        const file = await fetchRawFile(ghInfo);
        if (!file || file.error) {
          return {
            content: [{ type: "text", text: file?.error ? `Error: ${file.error}` : "Failed to fetch file from GitHub" }],
            details: { error: file?.error || "Raw fetch failed" }
          };
        }

        const { text, truncated } = truncate(file.content);
        return {
          content: [{ type: "text", text: `## ${file.path}\n\n\`\`\`\n${text}\n\`\`\`` }],
          details: { path: file.path, length: file.content.length, truncated }
        };
      }

      if (ghInfo?.type === "tree" && ghInfo.filePath) {
        const entries = await fetchTreeContents(ghInfo, ghInfo.filePath, ghInfo.ref);
        if (!entries) {
          return {
            content: [{ type: "text", text: `Failed to list \`${ghInfo.filePath}\` in ${ghInfo.owner}/${ghInfo.repo}` }],
            details: { error: "Tree fetch failed" }
          };
        }
        const header = `## ${ghInfo.owner}/${ghInfo.repo}/${ghInfo.filePath} @ \`${ghInfo.ref}\``;
        return {
          content: [{ type: "text", text: `${header}\n\n${formatTreeEntries(entries)}` }],
          details: { path: ghInfo.filePath, entryCount: entries.length }
        };
      }

      if (ghInfo) {
        const overview = await describeRepo(ghInfo);
        if (!overview) {
          return {
            content: [{ type: "text", text: `Failed to fetch repo metadata for ${ghInfo.owner}/${ghInfo.repo}` }],
            details: { error: "Repo describe failed" }
          };
        }
        const { text, truncated } = truncate(formatRepoOverview(overview));
        return {
          content: [{ type: "text", text }],
          details: {
            repo: overview.metadata.fullName,
            ref: overview.ref,
            entryCount: overview.entries.length,
            truncated
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
      const ghInfo = isGitHubUrl(url) ? parseGitHubUrl(url) : null;
      const isBlob = ghInfo?.type === "blob" && ghInfo.filePath;
      const isTree = ghInfo?.type === "tree" && ghInfo.filePath;
      const isRepo = ghInfo && !isBlob && !isTree;
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      const prefix = isBlob ? "raw " : isTree ? "ls " : isRepo ? "describe " : "fetch ";
      const color = ghInfo ? "warning" : "accent";
      return new Text(theme.fg("toolTitle", prefix) + theme.fg(color, display), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.repo) {
        return new Text(theme.fg("success", details.repo) + theme.fg("muted", ` @ ${details.ref}`), 0, 0);
      }
      if (details?.entryCount !== undefined && details?.path) {
        return new Text(theme.fg("success", `${details.entryCount} entries`), 0, 0);
      }
      if (details?.path) {
        return new Text(theme.fg("success", details.path) + (details?.truncated ? theme.fg("warning", " [truncated]") : ""), 0, 0);
      }
      const length = details?.length || 0;
      return new Text(theme.fg("success", `${length} chars`) + (details?.truncated ? theme.fg("warning", " [truncated]") : ""), 0, 0);
    }
  });

  pi.registerTool({
    name: "clone_repo",
    label: "Clone Repository",
    description: "Shallow-clone a GitHub repository to a local temp directory for filesystem exploration. Use this when you need to read, grep, or navigate many files across a repo. For quick metadata/README or a single file, use fetch_content instead.",
    parameters: Type.Object({
      url: Type.String({ description: "GitHub repo URL" })
    }),

    async execute(_id, params, signal) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted" }] };
      }

      const ghInfo = isGitHubUrl(params.url) ? parseGitHubUrl(params.url) : null;
      if (!ghInfo) {
        return {
          content: [{ type: "text", text: "Not a GitHub URL" }],
          details: { error: "Invalid URL" }
        };
      }

      const repo = await cloneRepo(ghInfo);
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
          files: repo.files.slice(0, 10)
        }
      };
    },

    renderCall(args, theme) {
      const url = (args as any).url || "";
      const display = url.length > 50 ? url.slice(0, 47) + "..." : url;
      return new Text(theme.fg("toolTitle", "clone ") + theme.fg("warning", display), 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.localPath) {
        return new Text(theme.fg("success", "cloned") + theme.fg("muted", ` ${details.fileCount} files`), 0, 0);
      }
      return new Text(theme.fg("error", "failed"), 0, 0);
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
