# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-06-05

### Added
- GitHub URL resolution in `fetch_content`, reintroduced API-first (no repo cloning, no `git` dependency): `…/blob/<ref>/<file>` is fetched from `raw.githubusercontent.com`, directories and repo roots via the GitHub API, and private repos via the `gh` CLI when installed and authenticated. Issues, PRs, wikis, and discussions fall through to the generic Readability path. Branch/tag names containing slashes (e.g. `release/8.0`) are disambiguated automatically, and the resolved source (raw URL or `gh` command) is surfaced in the tool result.
- Authenticated `gh`, when available, is preferred for directory/repo fetches (5000 req/hr) over the unauthenticated GitHub API (60 req/hr). When a private resource can't be reached without `gh`, the tool returns the exact `gh`/`git` command to run in your shell.
- `tsconfig.json` (strict mode + `noUncheckedIndexedAccess`) and a `typecheck` npm script.

### Changed
- Migrated peer dependencies from the deprecated `@mariozechner/*` scope to `@earendil-works/*` (`pi-coding-agent`, `pi-tui`), matching the current Pi runtime (0.78.x).
- Shared HTTP utility (`http.ts`) for size-limited fetching and content-type handling, used by both the generic fetch and GitHub paths.
- Internal cleanup: consolidated tool-result builders, typed the search cache (now backed by `lru-cache`), and made tool result details fully typed end to end.

## [2.0.0] - 2026-04-25

### Removed (BREAKING)
- All GitHub-specific handling: deleted `github.ts`, removed the `clone_repo` tool, and removed the GitHub repo/tree/blob branches from `fetch_content`. GitHub URLs now flow through the generic Readability path. Use the `gh` CLI for GitHub-specific reads (trees, issues, PRs, workflows, releases).
- `git` subprocess dependency.

## [1.0.4] - 2025-03-01

### Changed
- Code cleanup: removed experimental query editor feature to maintain clean agent workflow.

## [1.0.3] - 2025-03-01

### Fixed
- Gist URLs (gist.github.com) are now fetched as regular web content instead of attempting to clone them as repositories.

## [1.0.2] - 2025-03-01

### Fixed
- GitHub blob and tree URLs now clone correctly. Previously, URLs like `github.com/owner/repo/blob/main/file.md` would fail because the full URL was passed to `git clone`. Now the URL is parsed to extract the owner, repo, and branch, and a clean clone URL is constructed.

## [1.0.1] - 2025-02-25

### Changed
- Updated package description and metadata

## [1.0.0] - 2025-02-25

### Added
- Initial release
- `web_search` tool - Search the web via SearXNG
- `fetch_content` tool - Extract article content from URLs
- `get_search_results` tool - Retrieve cached search results by ID
- Automatic GitHub repository cloning when fetching GitHub URLs
