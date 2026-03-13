/** Circular buffer of recent agent events for reconnection catch-up */
export class EventBuffer {
	private buffer: unknown[] = [];
	private maxSize: number;

	constructor(maxSize = 1000) {
		this.maxSize = maxSize;
	}

	push(event: unknown): void {
		this.buffer.push(event);
		if (this.buffer.length > this.maxSize) {
			this.buffer.shift();
		}
	}

	getAll(): unknown[] {
		return [...this.buffer];
	}

	clear(): void {
		this.buffer = [];
	}

	get size(): number {
		return this.buffer.length;
	}
}
