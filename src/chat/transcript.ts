/** Chat transcript model shared by the extension host and the webview. */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface TranscriptEntry {
	role: 'user' | 'assistant';
	content: string;
	/** Reasoning trace produced by `deepseek-reasoner`. */
	reasoning?: string;
	/** Set when the request failed or was stopped before finishing. */
	error?: string;
}

/** Entries kept in the transcript. Older turns are dropped so the panel stays responsive. */
export const MAX_TRANSCRIPT_ENTRIES = 60;

/** Messages sent to the API per request; the tail of the conversation is used. */
export const MAX_API_MESSAGES = 30;

export const SYSTEM_PROMPT = [
	'You are DeepSeek Agent, a coding assistant inside Visual Studio Code.',
	'Be concise and technical. Prefer short paragraphs, bullet points, and fenced code blocks with a language tag.',
	'When you show code, keep it copy-paste ready and mention the file path it belongs to when relevant.',
	'If a request is ambiguous, state your assumption in one short sentence and continue.',
].join(' ');
