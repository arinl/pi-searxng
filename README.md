# pi-searxng

SearXNG web search extension for [Pi](https://github.com/badlogic/pi-mono) with automatic GitHub repository cloning.

## Features

- **Web Search** - Search the web via SearXNG instance
- **Content Fetching** - Extract article content from URLs (converts HTML to Markdown)
- **Auto GitHub Cloning** - Automatically clones GitHub repos when fetching GitHub URLs

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

Or use environment variable:

```bash
export SEARXNG_URL=http://localhost:8080
```

## Tools

### `web_search`

Search the web using SearXNG.

**Parameters:**
- `query` (string, required) - Search query
- `limit` (number, optional) - Max results (default: 10)

### `fetch_content`

Fetch URL content. Automatically clones GitHub repositories.

**Parameters:**
- `url` (string, required) - URL to fetch

For GitHub URLs, the repo is cloned to a temp directory and file listings are returned.

### `get_search_results`

Retrieve cached search results by ID.

**Parameters:**
- `searchId` (string, required) - Search ID from previous `web_search` call

## System Requirements

- Node.js 18+
- `git` command (for GitHub cloning)
- SearXNG instance (for web search)

## License

MIT
