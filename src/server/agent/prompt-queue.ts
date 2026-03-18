import { randomUUID } from "node:crypto";
import type { QueuedMessage } from "../ws/protocol.js";

/**
 * Server-side prompt queue for a single session.
 * Steered messages sort before non-steered, stable within each group.
 */
export class PromptQueue {
	private queue: QueuedMessage[] = [];

	/** Create a queue, optionally restoring from persisted data. */
	constructor(initial?: QueuedMessage[]) {
		if (initial) {
			this.queue = [...initial];
		}
	}

	/** Add a message to the end of the queue. Returns the queued message. */
	enqueue(text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
	}): QueuedMessage {
		const msg: QueuedMessage = {
			id: randomUUID(),
			text,
			isSteered: opts?.isSteered ?? false,
			createdAt: Date.now(),
		};
		if (opts?.images?.length) msg.images = opts.images;
		if (opts?.attachments?.length) msg.attachments = opts.attachments;

		this.queue.push(msg);
		if (msg.isSteered) this.reorder();
		return msg;
	}

	/**
	 * Mark a message as steered and reorder.
	 * Steered messages sort before non-steered, stable within each group.
	 * Returns true if the message was found and updated.
	 */
	steer(messageId: string): boolean {
		const msg = this.queue.find(m => m.id === messageId);
		if (!msg) return false;
		if (msg.isSteered) return true; // already steered
		msg.isSteered = true;
		this.reorder();
		return true;
	}

	/** Remove a message from the queue. Returns true if found and removed. */
	remove(messageId: string): boolean {
		const idx = this.queue.findIndex(m => m.id === messageId);
		if (idx === -1) return false;
		this.queue.splice(idx, 1);
		return true;
	}

	/** Pop the next message from the front of the queue. Returns undefined if empty. */
	dequeue(): QueuedMessage | undefined {
		return this.queue.shift();
	}

	/** Peek at the front of the queue without removing. */
	peek(): QueuedMessage | undefined {
		return this.queue[0];
	}

	/** Get the full queue as an array (for broadcasting). */
	toArray(): QueuedMessage[] {
		return [...this.queue];
	}

	/** Number of messages in the queue. */
	get length(): number {
		return this.queue.length;
	}

	/** Whether the queue is empty. */
	get isEmpty(): boolean {
		return this.queue.length === 0;
	}

	/**
	 * Stable reorder: steered messages first, non-steered second.
	 * Within each group, original insertion order is preserved.
	 */
	private reorder(): void {
		const steered = this.queue.filter(m => m.isSteered);
		const normal = this.queue.filter(m => !m.isSteered);
		this.queue = [...steered, ...normal];
	}
}
