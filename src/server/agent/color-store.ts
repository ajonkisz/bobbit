import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-session-colors.json");

/**
 * Persists session → palette index mapping to disk.
 * Ensures bobbit colors are stable across refreshes and devices.
 */
export class ColorStore {
	private colors: Map<string, number> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, idx] of Object.entries(data)) {
						if (typeof idx === "number") this.colors.set(id, idx);
					}
				}
			}
		} catch (err) {
			console.error("[color-store] Failed to load session colors:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Object.fromEntries(this.colors);
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[color-store] Failed to save session colors:", err);
		}
	}

	get(sessionId: string): number | undefined {
		return this.colors.get(sessionId);
	}

	set(sessionId: string, paletteIndex: number): void {
		this.colors.set(sessionId, paletteIndex);
		this.save();
	}

	getAll(): Record<string, number> {
		return Object.fromEntries(this.colors);
	}

	remove(sessionId: string): void {
		this.colors.delete(sessionId);
		this.save();
	}
}
