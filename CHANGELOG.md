# Change Log

All notable changes to the "deepseek-agent-coder" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.0]

### Added

- Dockable DeepSeek chat panel: a `webview` view in its own activity-bar container, so it can be moved to any sidebar or the panel area.
- Streaming chat against the DeepSeek API (`deepseek-chat` and `deepseek-reasoner`), with a collapsible reasoning block for R1.
- Markdown rendering in answers, fenced code blocks with copy buttons, and external links that open in the browser.
- In-panel settings page: API key, model, and API base URL, reachable from the gear button in the view title bar.
- API key stored in `vscode.SecretStorage` and verified against `GET /models` on save; `DEEPSEEK_API_KEY` environment variable as a development fallback.
- Commands: `Open Chat`, `New Chat`, `Chat Settings`, `Set API Key`, `Clear API Key`.
- Friendly error messages for 401/402/403/429/5xx responses and mid-stream cancellation.
- Transcript persisted per workspace and restored when the view is recreated.
- Unit tests for the SSE parser and endpoint helpers.
