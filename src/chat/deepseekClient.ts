import { SseParser } from './sse';
import type { ChatMessage } from './transcript';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const AVAILABLE_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

export class DeepSeekError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
		this.name = 'DeepSeekError';
	}
}

export interface StreamDelta {
	content: string;
	reasoning: string;
}

export interface StreamChatOptions {
	model: string;
	messages: ChatMessage[];
	signal: AbortSignal;
	onDelta: (delta: StreamDelta) => void;
}

export function normalizeBaseUrl(baseUrl: string | undefined): string {
	const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
	return trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
}

export function chatCompletionsUrl(baseUrl: string | undefined): string {
	const base = normalizeBaseUrl(baseUrl);
	return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

export function modelsUrl(baseUrl: string | undefined): string {
	const base = normalizeBaseUrl(baseUrl);
	return /\/models$/i.test(base) ? base : `${base}/models`;
}

function friendlyStatusMessage(status: number): string {
	switch (status) {
		case 400:
			return 'DeepSeek rejected the request (400). The selected model may not support this input.';
		case 401:
			return 'Invalid API key. Check it in the chat settings.';
		case 402:
			return 'Insufficient balance on your DeepSeek account.';
		case 403:
			return 'This API key is not allowed to use the requested model.';
		case 404:
			return 'Endpoint not found. Check the base URL in the chat settings.';
		case 429:
			return 'Rate limit reached. Wait a moment and try again.';
		case 500:
		case 502:
		case 503:
		case 504:
			return 'The DeepSeek service is temporarily unavailable. Try again shortly.';
		default:
			return `Request failed with status ${status}.`;
	}
}

async function describeFailure(response: Response): Promise<string> {
	let detail = '';
	try {
		const text = await response.text();
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string } | string };
			detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? text);
		} catch {
			detail = text;
		}
	} catch {
		// Ignore: the body was unreadable, the status message is enough.
	}

	const summary = friendlyStatusMessage(response.status);
	const trimmedDetail = detail.trim().slice(0, 400);
	return trimmedDetail.length > 0 ? `${summary}\n\n${trimmedDetail}` : summary;
}

export class DeepSeekClient {
	constructor(private readonly apiKey: string, private readonly baseUrl: string | undefined) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			Accept: 'application/json',
		};
	}

	/** Cheap key/endpoint check used by the settings UI. */
	async verify(signal?: AbortSignal): Promise<string[]> {
		let response: Response;
		try {
			response = await fetch(modelsUrl(this.baseUrl), { headers: this.headers(), signal });
		} catch (error) {
			throw new DeepSeekError(`Could not reach the DeepSeek API: ${errorMessage(error)}`);
		}

		if (!response.ok) {
			throw new DeepSeekError(await describeFailure(response), response.status);
		}

		const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
		return (payload.data ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === 'string');
	}

	/** Streams a chat completion, invoking `onDelta` for every token chunk. */
	async streamChat(options: StreamChatOptions): Promise<void> {
		let response: Response;
		try {
			response = await fetch(chatCompletionsUrl(this.baseUrl), {
				method: 'POST',
				headers: { ...this.headers(), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: options.model,
					messages: options.messages,
					stream: true,
				}),
				signal: options.signal,
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			throw new DeepSeekError(`Could not reach the DeepSeek API: ${errorMessage(error)}`);
		}

		if (!response.ok) {
			throw new DeepSeekError(await describeFailure(response), response.status);
		}
		if (!response.body) {
			throw new DeepSeekError('DeepSeek returned an empty response body.');
		}

		let streamError: DeepSeekError | undefined;

		const parser = new SseParser((event) => {
			if (event.data === '[DONE]') {
				return;
			}

			let payload: unknown;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}

			const chunk = payload as {
				error?: { message?: string };
				choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
			};

			if (chunk.error?.message) {
				streamError = new DeepSeekError(chunk.error.message);
				return;
			}

			const delta = chunk.choices?.[0]?.delta;
			const content = typeof delta?.content === 'string' ? delta.content : '';
			const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
			if (content.length > 0 || reasoning.length > 0) {
				options.onDelta({ content, reasoning });
			}
		});

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				parser.push(decoder.decode(value, { stream: true }));
				if (streamError) {
					break;
				}
			}
			parser.push(decoder.decode());
			parser.flush();
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			throw new DeepSeekError(`The response stream ended unexpectedly: ${errorMessage(error)}`);
		} finally {
			// Cancelling a finished stream is a no-op; cancelling an in-flight one stops the download.
			void reader.cancel().catch(() => undefined);
		}

		if (streamError) {
			throw streamError;
		}
	}
}

export function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'AbortError' || error.message === 'This operation was aborted')
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
