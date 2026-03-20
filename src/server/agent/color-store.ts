import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-session-colors.json");

/**
 * Mapping from old 20-colour palette indices to new 18-colour palette indices.
 * Old indices 8 (hue 200°) and 19 (hue 250°) were removed.
 * - 0-7: unchanged
 * - 8 (removed 200°) → 7 (175°, nearest neighbour)
 * - 9-18: shift down by 1
 * - 19 (removed 250°) → 8 (225°, nearest neighbour)
 */
const OLD_TO_NEW_INDEX: number[] = [
	0, 1, 2, 3, 4, 5, 6, 7, // 0-7: unchanged
	7,                        // 8 (200°) → 7 (175°)
	8, 9, 10, 11, 12, 13, 14, 15, 16, 17, // 9-18 → 8-17
	8,                        // 19 (250°) → 8 (225°)
];

/** Current palette version. Bump when palette changes require migration. */
const PALETTE_VERSION = 2;

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
						if (id.startsWith("_")) continue; // skip metadata keys
						if (typeof idx === "number") this.colors.set(id, idx);
					}
					// Migrate from old 20-colour palette if needed
					if (typeof data._paletteVersion !== "number" || data._paletteVersion < PALETTE_VERSION) {
						this.migrateFromOldPalette();
					}
				}
			}
		} catch (err) {
			console.error("[color-store] Failed to load session colors:", err);
		}
	}

	/** Remap all indices from the old 20-colour palette to the new 18-colour palette. */
	private migrateFromOldPalette(): void {
		let changed = false;
		for (const [id, idx] of this.colors) {
			if (idx >= 0 && idx < OLD_TO_NEW_INDEX.length) {
				const newIdx = OLD_TO_NEW_INDEX[idx];
				if (newIdx !== idx) {
					this.colors.set(id, newIdx);
					changed = true;
				}
			} else if (idx > 17) {
				// Any index out of new range → clamp to max
				this.colors.set(id, 17);
				changed = true;
			}
		}
		if (changed) {
			console.log(`[color-store] Migrated session colors from old 20-colour palette to 18-colour palette`);
		}
		this.save();
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data: Record<string, number> = { _paletteVersion: PALETTE_VERSION, ...Object.fromEntries(this.colors) };
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
