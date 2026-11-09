/** Message shapes exchanged between the extension host and the chat webview. */
import type { TranscriptEntry } from './transcript';

export interface UiConfig {
	hasApiKey: boolean;
	/** Masked hint such as `••••3f2a`, or an empty string when no key is stored. */
	keyHint: string;
	model: string;
	baseUrl: string;
	models: string[];
	/** True while a completion is streaming, so the UI can survive a webview reload. */
	busy: boolean;
}

/** Messages posted by the webview. */
export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'send'; requestId: string; text: string }
	| { type: 'stop' }
	| { type: 'newChat' }
	| { type: 'saveSettings'; apiKey?: string; model: string; baseUrl: string }
	| { type: 'clearApiKey' }
	| { type: 'openSettings' }
	| { type: 'openExternal'; url: string };

/** Messages posted by the extension host. */
export type HostMessage =
	| { type: 'init'; config: UiConfig; transcript: TranscriptEntry[] }
	| { type: 'config'; config: UiConfig }
	| { type: 'transcript'; transcript: TranscriptEntry[] }
	| { type: 'accepted'; requestId: string }
	| { type: 'append'; entry: TranscriptEntry }
	| { type: 'delta'; requestId: string; content: string; reasoning: string }
	| { type: 'done'; requestId: string }
	| { type: 'error'; requestId?: string; message: string; needsApiKey?: boolean }
	| { type: 'notice'; message: string }
	| { type: 'openSettings' };
