import * as assert from 'assert';
import { chatCompletionsUrl, modelsUrl, normalizeBaseUrl } from '../chat/deepseekClient';
import { SseParser, type SseEvent } from '../chat/sse';

suite('SSE parser', () => {
	function collect(chunks: string[]): SseEvent[] {
		const events: SseEvent[] = [];
		const parser = new SseParser((event) => events.push(event));
		for (const chunk of chunks) {
			parser.push(chunk);
		}
		parser.flush();
		return events;
	}

	test('parses one data payload per blank line', () => {
		const events = collect(['data: {"a":1}\n\ndata: {"a":2}\n\n']);
		assert.deepStrictEqual(events.map((event) => event.data), ['{"a":1}', '{"a":2}']);
	});

	test('reassembles payloads split across chunks', () => {
		const events = collect(['data: {"cho', 'ices":[{"delta":{"con', 'tent":"hi"}}]}\n\n']);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].data, '{"choices":[{"delta":{"content":"hi"}}]}');
	});

	test('joins multiple data lines with a newline and keeps the event name', () => {
		const events = collect(['event: message\ndata: line one\ndata: line two\n\n']);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event, 'message');
		assert.strictEqual(events[0].data, 'line one\nline two');
	});

	test('handles CRLF line endings', () => {
		const events = collect(['data: hello\r\n\r\n']);
		assert.deepStrictEqual(events.map((event) => event.data), ['hello']);
	});

	test('ignores comments and keep-alive pings', () => {
		const events = collect([': ping\n\n', 'data: real\n\n']);
		assert.deepStrictEqual(events.map((event) => event.data), ['real']);
	});

	test('flushes a final event without a trailing newline', () => {
		const events = collect(['data: [DONE]']);
		assert.deepStrictEqual(events.map((event) => event.data), ['[DONE]']);
	});

	test('does not emit empty events', () => {
		const events = collect(['\n\n\n']);
		assert.strictEqual(events.length, 0);
	});
});

suite('DeepSeek endpoint helpers', () => {
	test('normalizes the base URL', () => {
		assert.strictEqual(normalizeBaseUrl(' https://api.deepseek.com/// '), 'https://api.deepseek.com');
		assert.strictEqual(normalizeBaseUrl(''), 'https://api.deepseek.com');
		assert.strictEqual(normalizeBaseUrl(undefined), 'https://api.deepseek.com');
	});

	test('builds the chat completions URL', () => {
		assert.strictEqual(chatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
		assert.strictEqual(
			chatCompletionsUrl('https://api.deepseek.com/chat/completions'),
			'https://api.deepseek.com/chat/completions',
		);
		assert.strictEqual(
			chatCompletionsUrl('https://gateway.example.com/v1'),
			'https://gateway.example.com/v1/chat/completions',
		);
	});

	test('builds the models URL', () => {
		assert.strictEqual(modelsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/models');
		assert.strictEqual(modelsUrl('https://api.deepseek.com/models'), 'https://api.deepseek.com/models');
	});
});
