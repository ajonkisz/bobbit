import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

const STORE_NAME = "command-history";
const MAX_ENTRIES = 100;

export interface CommandHistoryEntry {
	/** Composite key: `${sessionId}:${timestamp}` */
	id: string;
	sessionId: string;
	text: string;
	timestamp: number;
}

/**
 * Store for per-session command history (up-arrow recall).
 * Entries are ordered by timestamp and capped at MAX_ENTRIES per session.
 */
export class CommandHistoryStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: STORE_NAME,
			keyPath: "id",
			indices: [
				{ name: "sessionId", keyPath: "sessionId" },
				{ name: "timestamp", keyPath: "timestamp" },
			],
		};
	}

	/**
	 * Add a command to history for a session.
	 * Deduplicates consecutive identical entries.
	 * Trims oldest entries if over MAX_ENTRIES.
	 */
	async addEntry(sessionId: string, text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;

		const backend = this.getBackend();

		// Get existing entries for this session
		const allKeys = await backend.keys(STORE_NAME, `${sessionId}:`);
		const entries: CommandHistoryEntry[] = [];
		for (const key of allKeys) {
			const entry = await backend.get<CommandHistoryEntry>(STORE_NAME, key);
			if (entry) entries.push(entry);
		}
		entries.sort((a, b) => a.timestamp - b.timestamp);

		// Skip if the most recent entry is identical
		if (entries.length > 0 && entries[entries.length - 1].text === trimmed) {
			return;
		}

		// Add new entry
		const timestamp = Date.now();
		const entry: CommandHistoryEntry = {
			id: `${sessionId}:${timestamp}`,
			sessionId,
			text: trimmed,
			timestamp,
		};
		await backend.set(STORE_NAME, entry.id, entry);

		// Trim if over limit
		if (entries.length >= MAX_ENTRIES) {
			const toRemove = entries.slice(0, entries.length - MAX_ENTRIES + 1);
			for (const old of toRemove) {
				await backend.delete(STORE_NAME, old.id);
			}
		}
	}

	/**
	 * Get command history for a session, newest last.
	 */
	async getHistory(sessionId: string): Promise<string[]> {
		const backend = this.getBackend();
		const allKeys = await backend.keys(STORE_NAME, `${sessionId}:`);
		const entries: CommandHistoryEntry[] = [];
		for (const key of allKeys) {
			const entry = await backend.get<CommandHistoryEntry>(STORE_NAME, key);
			if (entry) entries.push(entry);
		}
		entries.sort((a, b) => a.timestamp - b.timestamp);
		return entries.map((e) => e.text);
	}

	/**
	 * Clear all history for a session.
	 */
	async clearHistory(sessionId: string): Promise<void> {
		const backend = this.getBackend();
		const allKeys = await backend.keys(STORE_NAME, `${sessionId}:`);
		for (const key of allKeys) {
			await backend.delete(STORE_NAME, key);
		}
	}
}
