# pi-searxng

SearXNG web search and HTML-to-markdown fetch extension for [Pi](https://github.com/badlogic/pi-mono).

## Features

- **Web Search** — search the web via a SearXNG instance.
- **Content Fetching** — fetch a URL and convert its HTML to markdown via Readability + turndown. JSON and plain-text content are returned as-is.
- **GitHub Resolution** — GitHub file, directory, and repo URLs are resolved to their actual content automatically (no rendered-HTML scraping), with no setup required for public repos.

## Installation

```bash
pi install npm:pi-searxng
```

Or try without installing:

```bash
pi -e npm:pi-searxng
```

## Configuration

Create `~/.pi/searxng.json`:

```json
{
  "searxngUrl": "http://localhost:8080",
  "timeoutMs": 30000,
  "maxResults": 10
}
```

Or set the SearXNG URL via env var:

```bash
export SEARXNG_URL=http://localhost:8080
```

## Tools

### `web_search`

Search the web using SearXNG. Supports time filtering, pagination, language, categories, and engine selection.

### `fetch_content`

Fetch a URL and return markdown. Use `headingsOnly: true` to scout long pages.

GitHub URLs are resolved to their content automatically — you pass the normal `github.com/...` URL and the tool picks the most capable path that needs the least setup:

| URL | Resolved via |
| --- | --- |
| `…/blob/<ref>/<file>` | `raw.githubusercontent.com` (public, no auth) |
| `…/tree/<ref>/<dir>` and repo root | GitHub API |
| Private repos (when public access returns 404/403) | `gh` CLI, if installed and authenticated |
| `…/pull/…`, `…/issues/…`, `/wiki`, `/discussions`, etc. | normal HTML-to-markdown fetch |

Branch/tag names containing slashes (e.g. `release/8.0`) are disambiguated automatically. The resolved source (raw URL or `gh` command) is shown in the tool result so the path taken is visible in the transcript.

If `gh` is installed **and** authenticated, directory/repo fetches use it directly (5000 req/hr) instead of the unauthenticated GitHub API (60 req/hr). When a private resource can't be reached and `gh` is unavailable, the tool returns the exact `gh`/`git` command to run in your shell.

### `get_search_results`

Retrieve cached search results by `searchId`.

## System Requirements

- Node.js 18+
- SearXNG instance
- [`gh` CLI](https://cli.github.com) — *optional*, only used to fetch **private** GitHub repos (public repos need nothing)

## License

MIT
