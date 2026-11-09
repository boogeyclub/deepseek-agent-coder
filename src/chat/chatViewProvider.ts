import * as vscode from 'vscode';
import {
	AVAILABLE_MODELS,
	DeepSeekClient,
	DeepSeekError,
	isAbortError,
	normalizeBaseUrl,
} from './deepseekClient';
import type { HostMessage, UiConfig, WebviewMessage } from './protocol';
import {
	MAX_API_MESSAGES,
	MAX_TRANSCRIPT_ENTRIES,
	SYSTEM_PROMPT,
	type TranscriptEntry,
} from './transcript';

export const VIEW_ID = 'deepseekAgent.chat';
export const SECRET_API_KEY = 'deepseekAgent.apiKey';
const TRANSCRIPT_KEY = 'deepseekAgent.transcript';
const CONFIG_SECTION = 'deepseekAgent';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = VIEW_ID;

	private view: vscode.WebviewView | undefined;
	private transcript: TranscriptEntry[];
	private controller: AbortController | undefined;
	private requestCounter = 0;
	private readonly disposables: vscode.Disposable[] = [];
	private viewDisposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.transcript = context.workspaceState.get<TranscriptEntry[]>(TRANSCRIPT_KEY, []);

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(CONFIG_SECTION)) {
					void this.postConfig();
				}
			}),
			context.secrets.onDidChange((event) => {
				if (event.key === SECRET_API_KEY) {
					void this.postConfig();
				}
			}),
		);
	}

	// ---------------------------------------------------------------------
	// Webview lifecycle
	// ---------------------------------------------------------------------

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;

		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		view.webview.html = this.renderHtml(view.webview);

		// A webview view is torn down and recreated whenever it is dragged to another
		// container, so its listeners must not pile up across resolutions.
		for (const disposable of this.viewDisposables) {
			disposable.dispose();
		}
		this.viewDisposables = [
			view.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void this.handleMessage(message);
			}),
			view.onDidDispose(() => {
				for (const disposable of this.viewDisposables) {
					disposable.dispose();
				}
				this.viewDisposables = [];
				if (this.view === view) {
					this.view = undefined;
				}
			}),
		];
	}

	/** Focus the panel, creating/showing it if it is collapsed. */
	async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
	}

	/** Focus the panel and open its settings page. */
	async revealSettings(): Promise<void> {
		await this.reveal();
		void this.post({ type: 'openSettings' });
	}

	dispose(): void {
		this.controller?.abort();
		this.controller = undefined;
		for (const disposable of [...this.viewDisposables, ...this.disposables]) {
			disposable.dispose();
		}
		this.viewDisposables = [];
		this.disposables.length = 0;
	}

	// ---------------------------------------------------------------------
	// Messages from the webview
	// ---------------------------------------------------------------------

	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					await this.postInitialState();
					return;
				case 'send':
					await this.send(message.text, message.requestId);
					return;
				case 'stop':
					this.controller?.abort();
					return;
				case 'newChat':
					this.newChat();
					return;
				case 'saveSettings':
					await this.saveSettings(message);
					return;
				case 'clearApiKey':
					await this.context.secrets.delete(SECRET_API_KEY);
					await this.postConfig();
					this.notify('API key removed.');
					return;
				case 'openSettings':
					await this.revealSettings();
					return;
				case 'openExternal':
					if (/^https:\/\//i.test(message.url)) {
						await vscode.env.openExternal(vscode.Uri.parse(message.url));
					}
					return;
			}
		} catch (error) {
			this.notify(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// ---------------------------------------------------------------------
	// Configuration helpers
	// ---------------------------------------------------------------------

	private getConfiguration(): vscode.WorkspaceConfiguration {
		return vscode.workspace.getConfiguration(CONFIG_SECTION);
	}

	private get model(): string {
		const model = this.getConfiguration().get<string>('model', AVAILABLE_MODELS[0]);
		return model.trim().length > 0 ? model.trim() : AVAILABLE_MODELS[0];
	}

	private get baseUrl(): string {
		return normalizeBaseUrl(this.getConfiguration().get<string>('baseUrl'));
	}

	private async getApiKey(): Promise<string | undefined> {
		const stored = await this.context.secrets.get(SECRET_API_KEY);
		if (stored && stored.trim().length > 0) {
			return stored.trim();
		}
		// Convenience for development: allow an environment variable fallback.
		const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
		return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
	}

	private async uiConfig(): Promise<UiConfig> {
		const key = await this.getApiKey();
		return {
			hasApiKey: Boolean(key),
			keyHint: key ? `••••${key.slice(-4)}` : '',
			model: this.model,
			baseUrl: this.baseUrl,
			models: AVAILABLE_MODELS,
			busy: Boolean(this.controller),
		};
	}

	private async saveSettings(message: Extract<WebviewMessage, { type: 'saveSettings' }>): Promise<void> {
		const configuration = this.getConfiguration();
		const model = message.model.trim() || AVAILABLE_MODELS[0];
		const baseUrl = normalizeBaseUrl(message.baseUrl);

		if (configuration.get<string>('model') !== model) {
			await configuration.update('model', model, vscode.ConfigurationTarget.Global);
		}
		if (normalizeBaseUrl(configuration.get<string>('baseUrl')) !== baseUrl) {
			await configuration.update('baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
		}

		const apiKey = message.apiKey?.trim();
		if (apiKey) {
			await this.context.secrets.store(SECRET_API_KEY, apiKey);
		}

		await this.postConfig();

		const keyToVerify = apiKey ?? (await this.getApiKey());
		if (!keyToVerify) {
			this.notify('Settings saved. Add an API key to start chatting.');
			return;
		}

		try {
			await new DeepSeekClient(keyToVerify, baseUrl).verify();
			this.notify(apiKey ? 'API key saved and verified.' : 'Settings saved.');
		} catch (error) {
			const detail = error instanceof DeepSeekError ? error.message : String(error);
			this.notify(`Settings saved, but the key could not be verified: ${detail}`);
		}
	}

	/** Prompt for a key from the command palette. */
	async promptForApiKey(): Promise<void> {
		const existing = await this.context.secrets.get(SECRET_API_KEY);
		const value = await vscode.window.showInputBox({
			title: 'DeepSeek API Key',
			prompt: 'Stored in VS Code SecretStorage and never written to settings.json.',
			placeHolder: existing ? 'A key is saved - enter a new one to replace it' : 'sk-...',
			password: true,
			ignoreFocusOut: true,
			validateInput: (input) => (input.trim().length === 0 ? 'The API key cannot be empty.' : undefined),
		});

		if (value === undefined) {
			return;
		}

		await this.context.secrets.store(SECRET_API_KEY, value.trim());
		await this.postConfig();

		try {
			await new DeepSeekClient(value.trim(), this.baseUrl).verify();
			void vscode.window.showInformationMessage('DeepSeek API key saved and verified.');
		} catch (error) {
			const detail = error instanceof DeepSeekError ? error.message : String(error);
			void vscode.window.showWarningMessage(`DeepSeek API key saved, but verification failed: ${detail}`);
		}
	}

	async clearApiKey(): Promise<void> {
		await this.context.secrets.delete(SECRET_API_KEY);
		await this.postConfig();
		void vscode.window.showInformationMessage('DeepSeek API key removed.');
	}

	// ---------------------------------------------------------------------
	// Chat
	// ---------------------------------------------------------------------

	/** Clears the conversation; exposed for the `deepseekAgent.newChat` command. */
	newChat(): void {
		this.controller?.abort();
		this.transcript = [];
		void this.context.workspaceState.update(TRANSCRIPT_KEY, this.transcript);
		void this.post({ type: 'transcript', transcript: this.transcript });
	}

	private async send(text: string, requestId: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			return;
		}

		if (this.controller) {
			void this.post({
				type: 'error',
				requestId,
				message: 'A response is still streaming. Stop it before sending another message.',
			});
			return;
		}

		const apiKey = await this.getApiKey();
		if (!apiKey) {
			void this.post({
				type: 'error',
				requestId,
				message: 'No DeepSeek API key yet. Add one to start chatting.',
				needsApiKey: true,
			});
			return;
		}

		this.requestCounter += 1;
		const controller = new AbortController();
		this.controller = controller;

		const userEntry: TranscriptEntry = { role: 'user', content: trimmed };
		this.transcript = trimTranscript([...this.transcript, userEntry]);

		void this.post({ type: 'accepted', requestId });
		void this.post({ type: 'append', entry: userEntry });

		const assistantEntry: TranscriptEntry = { role: 'assistant', content: '' };
		const client = new DeepSeekClient(apiKey, this.baseUrl);

		try {
			await client.streamChat({
				model: this.model,
				messages: this.buildMessages(),
				signal: controller.signal,
				onDelta: (delta) => {
					assistantEntry.content += delta.content;
					if (delta.reasoning) {
						assistantEntry.reasoning = (assistantEntry.reasoning ?? '') + delta.reasoning;
					}
					void this.post({
						type: 'delta',
						requestId,
						content: assistantEntry.content,
						reasoning: assistantEntry.reasoning ?? '',
					});
				},
			});

			if (assistantEntry.content.trim().length === 0) {
				assistantEntry.error = 'The model returned no content.';
			}
			void this.post({ type: 'done', requestId });
		} catch (error) {
			if (isAbortError(error)) {
				if (assistantEntry.content.trim().length === 0) {
					assistantEntry.error = 'Stopped.';
				} else {
					assistantEntry.content = `${assistantEntry.content}\n\n_(stopped)_`;
				}
				void this.post({ type: 'done', requestId });
			} else {
				const message = error instanceof Error ? error.message : String(error);
				assistantEntry.error = message;
				void this.post({
					type: 'error',
					requestId,
					message,
					needsApiKey: error instanceof DeepSeekError && error.status === 401,
				});
			}
		} finally {
			if (this.controller === controller) {
				this.controller = undefined;
			}

			if (assistantEntry.content.trim().length > 0 || assistantEntry.error) {
				this.transcript = trimTranscript([...this.transcript, assistantEntry]);
				await this.context.workspaceState.update(TRANSCRIPT_KEY, this.transcript);
			}
			await this.postConfig();
		}
	}

	private buildMessages() {
		const history = this.transcript
			.filter((entry) => !entry.error && entry.content.trim().length > 0)
			.slice(-MAX_API_MESSAGES)
			.map((entry) => ({ role: entry.role, content: entry.content }));

		return [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...history];
	}

	// ---------------------------------------------------------------------
	// Plumbing
	// ---------------------------------------------------------------------

	private async postInitialState(): Promise<void> {
		const config = await this.uiConfig();
		void this.post({ type: 'init', config, transcript: this.transcript });
	}

	private async postConfig(): Promise<void> {
		const config = await this.uiConfig();
		void this.post({ type: 'config', config });
	}

	private notify(message: string): void {
		void this.post({ type: 'notice', message });
	}

	private async post(message: HostMessage): Promise<void> {
		await this.view?.webview.postMessage(message);
	}

	private renderHtml(webview: vscode.Webview): string {
		const nonce = createNonce();
		const asset = (file: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));

		const styleUri = asset('chat.css');
		const scriptUri = asset('chat.js');
		const iconUri = asset('deepseek.svg');
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
			'base-uri none',
			'form-action none',
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${styleUri}" />
	<title>DeepSeek Chat</title>
</head>
<body data-icon="${iconUri}">
	<div class="app">
		<header class="toolbar">
			<button id="model-chip" class="chip" type="button" title="Change model">
				<span class="dot"></span>
				<span id="model-label">deepseek-chat</span>
				<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 11 3.5 6.5h9L8 11Z"/></svg>
			</button>
			<span class="spacer"></span>
			<button id="btn-new-chat" class="icon-button" type="button" title="New chat">
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 2.5a.75.75 0 0 1 .75.75v4h4a.75.75 0 0 1 0 1.5h-4v4a.75.75 0 0 1-1.5 0v-4h-4a.75.75 0 0 1 0-1.5h4v-4A.75.75 0 0 1 8 2.5Z"/></svg>
			</button>
			<button id="btn-settings" class="icon-button" type="button" title="Settings">
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5.75A2.25 2.25 0 1 0 8 10.25 2.25 2.25 0 0 0 8 5.75Zm0 1.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"/><path fill="currentColor" d="M6.98 1.5a1.3 1.3 0 0 0-1.28 1.06l-.13.72a5.5 5.5 0 0 0-.78.45l-.68-.27a1.3 1.3 0 0 0-1.55.53l-.75 1.3a1.3 1.3 0 0 0 .3 1.6l.55.47a5.6 5.6 0 0 0 0 .9l-.55.47a1.3 1.3 0 0 0-.3 1.6l.75 1.3a1.3 1.3 0 0 0 1.55.53l.68-.27c.25.17.51.32.78.45l.13.72a1.3 1.3 0 0 0 1.28 1.06h1.5a1.3 1.3 0 0 0 1.28-1.06l.13-.72c.27-.13.53-.28.78-.45l.68.27a1.3 1.3 0 0 0 1.55-.53l.75-1.3a1.3 1.3 0 0 0-.3-1.6l-.55-.47a5.6 5.6 0 0 0 0-.9l.55-.47a1.3 1.3 0 0 0 .3-1.6l-.75-1.3a1.3 1.3 0 0 0-1.55-.53l-.68.27a5.5 5.5 0 0 0-.78-.45l-.13-.72A1.3 1.3 0 0 0 10.48 1.5h-1.5Z"/></svg>
			</button>
		</header>

		<main id="messages" class="messages" aria-live="polite">
			<section id="empty-state" class="empty-state">
				<img class="empty-logo" alt="" />
				<h1>DeepSeek Agent</h1>
				<p>Ask about your code, paste an error, or plan a change. Your key stays in VS Code SecretStorage.</p>
				<div class="suggestions">
					<button class="suggestion" type="button" data-prompt="Explain what this project does, based on the files that are open.">Explain this project</button>
					<button class="suggestion" type="button" data-prompt="Write a unit test for the file I have open.">Write a unit test</button>
					<button class="suggestion" type="button" data-prompt="Find bugs in the code I paste next and suggest fixes.">Find bugs in my code</button>
				</div>
			</section>
		</main>

		<footer class="composer">
			<div class="composer-box" id="composer-box">
				<textarea id="input" rows="1" placeholder="Ask DeepSeek anything about your code" spellcheck="false"></textarea>
				<div class="composer-bar">
					<span class="hint" id="hint">Enter to send &middot; Shift+Enter for a new line</span>
					<button id="btn-send" class="send-button" type="button" title="Send">
						<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M1.7 1.4l13 6.2c.4.2.4.7 0 .9l-13 6.2c-.4.2-.9-.2-.8-.7l.9-4.7 8.2-1.5-8.2-1.5-.9-4.7c-.1-.5.4-.9.8-.7Z"/></svg>
						<span id="send-label">Send</span>
					</button>
				</div>
			</div>
			<div class="footnote">DeepSeek can make mistakes. Check important code.</div>
		</footer>

		<section id="settings" class="settings" hidden>
			<div class="settings-inner">
				<div class="settings-head">
					<h2>Settings</h2>
					<button id="btn-close-settings" class="icon-button" type="button" title="Close">
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4.1 3.05 8 6.94l3.9-3.9a.75.75 0 1 1 1.06 1.07L9.06 8l3.9 3.9a.75.75 0 1 1-1.06 1.06L8 9.06l-3.9 3.9a.75.75 0 0 1-1.06-1.06L6.94 8l-3.9-3.9A.75.75 0 0 1 4.1 3.05Z"/></svg>
					</button>
				</div>

				<label class="field">
					<span class="label">DeepSeek API key</span>
					<input id="input-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." />
					<span class="description" id="key-status">Loading...</span>
				</label>

				<label class="field">
					<span class="label">Model</span>
					<select id="input-model"></select>
				</label>

				<label class="field">
					<span class="label">API base URL</span>
					<input id="input-base-url" type="text" spellcheck="false" placeholder="https://api.deepseek.com" />
					<span class="description">Change only when you use a compatible gateway or proxy.</span>
				</label>

				<div class="settings-actions">
					<button id="btn-save-settings" class="primary" type="button">Save</button>
					<button id="btn-clear-key" class="secondary" type="button">Remove key</button>
					<button id="btn-get-key" class="link" type="button">Get a key</button>
				</div>

				<p class="settings-note">
					The key is stored with <code>vscode.SecretStorage</code> (the OS keychain), not in
					<code>settings.json</code>, and is only sent to the base URL above.
				</p>
			</div>
		</section>

		<div id="toast" class="toast" hidden></div>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function trimTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
	return entries.length > MAX_TRANSCRIPT_ENTRIES ? entries.slice(-MAX_TRANSCRIPT_ENTRIES) : entries;
}

function createNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
