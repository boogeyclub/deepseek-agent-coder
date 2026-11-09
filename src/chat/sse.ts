/**
 * Minimal Server-Sent Events parser (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 *
 * Deliberately dependency free and framework free so it can be unit tested without
 * the extension host.
 */
export interface SseEvent {
	/** Value of the optional `event:` field. */
	event?: string;
	/** Joined `data:` fields, with the trailing newline removed. */
	data: string;
}

export class SseParser {
	private buffer = '';
	private eventName: string | undefined;
	private dataLines: string[] = [];

	constructor(private readonly onEvent: (event: SseEvent) => void) {}

	/** Feed a decoded chunk of the response body into the parser. */
	push(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf('\n')) !== -1) {
			const rawLine = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			this.readLine(stripCarriageReturn(rawLine));
		}
	}

	/** Flush whatever is left in the buffer, e.g. when the stream ends without a trailing newline. */
	flush(): void {
		if (this.buffer.length > 0) {
			const rawLine = this.buffer;
			this.buffer = '';
			this.readLine(stripCarriageReturn(rawLine));
		}
		this.dispatch();
	}

	private readLine(line: string): void {
		if (line === '') {
			this.dispatch();
			return;
		}
		// Comments / keep-alive pings.
		if (line.startsWith(':')) {
			return;
		}

		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}

		if (field === 'data') {
			this.dataLines.push(value);
		} else if (field === 'event') {
			this.eventName = value;
		}
	}

	private dispatch(): void {
		if (this.dataLines.length === 0) {
			this.eventName = undefined;
			return;
		}

		const event: SseEvent = { event: this.eventName, data: this.dataLines.join('\n') };
		this.dataLines = [];
		this.eventName = undefined;
		this.onEvent(event);
	}
}

function stripCarriageReturn(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}
