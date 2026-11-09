# DeepSeek Agent Coder

A dockable **DeepSeek chat panel** for VS Code. It sits in the activity bar next to Copilot, streams answers from the DeepSeek API, and keeps your API key in the OS keychain — never in `settings.json`.

![activity bar](media/deepseek.svg)

## Features

- **Dockable chat view** — a `webview` view in its own activity-bar container, so you can drag it to the left sidebar, the right sidebar, the secondary side bar, or the panel like any other VS Code view.
- **Streaming chat** — token-by-token responses with markdown rendering, fenced code blocks with per-block **Copy** buttons, lists, quotes, links, and headings. Links open in your browser, not inside the webview.
- **Settings built into the panel** — the gear button opens an in-panel settings page for the API key, model, and base URL. The key is written to `vscode.SecretStorage` (OS keychain/keyring) and is verified against `GET /models` when you save it.
- **Model picker** — `deepseek-chat` (V3) and `deepseek-reasoner` (R1). Reasoning traces from R1 render in a collapsible *Reasoning* block above the answer.
- **Stop, retry-free errors** — sending, aborting mid-stream, and friendly error messages for 401 / 402 / 429 / 5xx responses.
- **Conversation survives reloads** — the transcript lives in the extension host (persisted per workspace) and is re-sent to the webview whenever it is recreated.
- **Command palette** — `DeepSeek: Open Chat`, `New Chat`, `Chat Settings`, `Set API Key`, `Clear API Key`.

## Getting started

1. Install dependencies and compile (or press `F5` to launch the Extension Development Host):

   ```bash
   npm install
   npm run compile
   ```

2. Click the **DeepSeek** icon in the activity bar.
3. Press the **gear** button (or run `DeepSeek: Set API Key`), paste a key from [platform.deepseek.com](https://platform.deepseek.com/api_keys), and hit **Save**. The panel reports whether the key was verified.
4. Ask a question. `Enter` sends, `Shift+Enter` inserts a newline, and the send button turns into **Stop** while a response streams.

## Extension settings

| Setting | Default | Description |
| --- | --- | --- |
| `deepseekAgent.model` | `deepseek-chat` | Model used by the panel. |
| `deepseekAgent.baseUrl` | `https://api.deepseek.com` | API root. Point it at a compatible gateway, proxy, or self-hosted endpoint if you use one. `/chat/completions` is appended automatically. |

The API key is **not** a setting. It is stored through `vscode.SecretStorage` and can be removed with `DeepSeek: Clear API Key` or the **Remove key** button in the panel.

### Environment variable fallback

For development, `DEEPSEEK_API_KEY` in the environment of the extension host is used when no key has been saved in SecretStorage. The keychain value always wins.

## Commands

| Command | Description |
| --- | --- |
| `deepseekAgent.openChat` | Reveal and focus the chat panel. |
| `deepseekAgent.newChat` | Clear the conversation. |
| `deepseekAgent.openSettings` | Open the panel and its settings page. |
| `deepseekAgent.setApiKey` | Prompt for an API key, store it, and verify it. |
| `deepseekAgent.clearApiKey` | Delete the stored key. |

## How it works

```
src/
  extension.ts               activation, command and webview registration
  chat/
    chatViewProvider.ts      the WebviewViewProvider: HTML/CSP, message routing, state
    deepseekClient.ts        fetch + streaming client for the DeepSeek API
    sse.ts                   dependency-free Server-Sent Events parser
    protocol.ts              typed messages between host and webview
    transcript.ts            transcript model, limits, system prompt
media/
  chat.js                    webview UI: markdown renderer, streaming, settings
  chat.css                   theme-aware styles built on VS Code CSS variables
  deepseek.svg               activity bar icon
```

The webview never sees the API key. It posts intents (`send`, `stop`, `saveSettings`, …) to the extension host, which owns the key, the HTTP client, and the transcript, and streams `delta` messages back. Rendering is done with a small markdown-to-HTML function that escapes input first, under a strict CSP (`default-src 'none'`, nonce-only scripts, no inline styles).

## Development

```bash
npm run watch    # incremental TypeScript build
npm run lint     # eslint src
npm test         # runs the mocha suites in a VS Code instance (downloads VS Code on first run)
```

## Known issues

- No editor context yet: the panel does not read the active file or selection, so you have to paste code into the chat. Editor context, inline edit commands and tool use are the next steps.
- One conversation per workspace; there is no session history list.
- `deepseek-reasoner` ignores `temperature`-style sampling parameters by design, so none are sent.

## Release notes

### 0.1.0

- Dockable DeepSeek chat panel with streaming responses, markdown and code blocks.
- In-panel settings with SecretStored and verified API key, model picker, custom base URL.
- Command palette integration and per-workspace transcript persistence.
