/**
 * Message queue state machine.
 *
 * Manages the queue of messages the user types while the agent is busy.
 * Messages can be:
 *   - Pending: waiting to be sent when the agent becomes idle
 *   - Steered: sent immediately as a steer (interrupt), shown with "Sent"
 *     badge until the agent's turn ends
 *
 * Extracted from AgentInterface so the logic is independently testable.
 */

export interface QueuedMessage {
	id: string;
	text: string;
	attachments?: any[];
	/** True after the user clicks Steer — shows "Sent" indicator until agent picks it up */
	steered?: boolean;
}

export interface MessageQueueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export class MessageQueue {
	private _messages: QueuedMessage[] = [];
	private _idCounter = 0;
	private _storageKey: string | undefined;
	private _storage: MessageQueueStorage | null;

	constructor(storageKey?: string, storage?: MessageQueueStorage) {
		this._storageKey = storageKey;
		this._storage = storage ?? null;
	}

	get messages(): readonly QueuedMessage[] {
		return this._messages;
	}

	get length(): number {
		return this._messages.length;
	}

	/** Add a message to the queue. Returns the new QueuedMessage. */
	enqueue(text: string, attachments?: any[]): QueuedMessage {
		const msg: QueuedMessage = {
			id: `q_${++this._idCounter}`,
			text,
			attachments: attachments?.length ? attachments : undefined,
		};
		this._messages = [...this._messages, msg];
		this._save();
		return msg;
	}

	/** Mark a queued message as steered (sent as interrupt). */
	steer(id: string): QueuedMessage | undefined {
		let steered: QueuedMessage | undefined;
		this._messages = this._messages.map((m) => {
			if (m.id === id) {
				steered = { ...m, steered: true };
				return steered;
			}
			return m;
		});
		this._save();
		return steered;
	}

	/** Remove a message from the queue without sending. */
	remove(id: string): void {
		this._messages = this._messages.filter((m) => m.id !== id);
		this._save();
	}

	/**
	 * Handle an agent event. Returns which action to take:
	 *   - "none": no action needed
	 *   - "drain": agent ended, drain the queue (call drain())
	 *   - "steered_cleared": steered messages were removed
	 */
	handleEvent(eventType: string): "none" | "drain" | "steered_cleared" {
		switch (eventType) {
			case "agent_end":
				return "drain";
			default:
				return "none";
		}
	}

	/**
	 * Drain the queue for sending. Returns the non-steered messages
	 * and clears the entire queue. Called on agent_end.
	 */
	drain(): QueuedMessage[] {
		const pending = this._messages.filter((m) => !m.steered);
		this._messages = [];
		this._save();
		return pending;
	}

	/** Restore from storage, filtering out stale steered messages. */
	restore(): void {
		if (!this._storageKey || !this._storage) return;
		try {
			const raw = this._storage.getItem(this._storageKey);
			if (raw) {
				const restored: QueuedMessage[] = JSON.parse(raw);
				if (Array.isArray(restored) && restored.length > 0) {
					// Drop steered messages — they were already sent to the
					// agent and we can't know if they were processed before
					// the page reloaded.
					this._messages = restored.filter((m) => !m.steered);
					this._idCounter = Math.max(
						this._idCounter,
						...restored.map((m) => {
							const n = parseInt(m.id.replace("q_", ""), 10);
							return isNaN(n) ? 0 : n;
						}),
					);
					this._save();
				}
			}
		} catch {
			/* parse error — ignore */
		}
	}

	private _save(): void {
		if (!this._storageKey || !this._storage) return;
		try {
			const serializable = this._messages.map(({ id, text, steered }) => ({
				id,
				text,
				steered,
			}));
			if (serializable.length > 0) {
				this._storage.setItem(this._storageKey, JSON.stringify(serializable));
			} else {
				this._storage.removeItem(this._storageKey);
			}
		} catch {
			/* quota exceeded — ignore */
		}
	}
}
