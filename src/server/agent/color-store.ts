import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-session-colors.json");

/**
 * Mapping from the original 20-colour palette indices to the current
 * 17-colour palette. Removed hues: 200° (old 8), 225° (old 9), 250° (old 19).
 *
 * Old palette: [0,25,50,75,100,125,150,175,200,225,-135,-110,-85,-60,-35,-10,15,40,65,250]
 * New palette: [0,25,50,75,100,125,150,175,-135,-110,-85,-60,-35,-10,15,40,65]
 *
 * - 0-7: unchanged
 * - 8 (removed 200°) → 7 (175°, nearest)
 * - 9 (removed 225°) → 7 (175°, nearest)
 * - 10-18: shift down by 2 (10→8, 11→9, ..., 18→16)
 * - 19 (removed 250°) → 8 (-135°, nearest in new palette)
 */
const V1_TO_CURRENT: number[] = [
	0, 1, 2, 3, 4, 5, 6, 7, // 0-7: unchanged
	7,                        // 8 (200°) → 7 (175°)
	7,                        // 9 (225°) → 7 (175°)
	8, 9, 10, 11, 12, 13, 14, 15, 16, // 10-18 → 8-16
	8,                        // 19 (250°) → 8 (-135°)
];

/**
 * Mapping from the intermediate 18-colour palette (v2) to the current
 * 17-colour palette. Removed hue: 225° (was at index 8 in v2).
 *
 * V2 palette: [0,25,50,75,100,125,150,175,225,-135,-110,-85,-60,-35,-10,15,40,65]
 * New palette: [0,25,50,75,100,125,150,175,-135,-110,-85,-60,-35,-10,15,40,65]
 */
const V2_TO_CURRENT: number[] = [
	0, 1, 2, 3, 4, 5, 6, 7, // 0-7: unchanged
	7,                        // 8 (225°) → 7 (175°)
	8, 9, 10, 11, 12, 13, 14, 15, 16, // 9-17 → 8-16
];

/** Current palette version. Bump when palette changes require migration. */
const PALETTE_VERSION = 3;

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
					// Migrate from old palette if needed
					const storedVersion = typeof data._paletteVersion === "number" ? data._paletteVersion : 1;
					if (storedVersion < PALETTE_VERSION) {
						this.migrateFromOldPalette(storedVersion);
					}
				}
			}
		} catch (err) {
			console.error("[color-store] Failed to load session colors:", err);
		}
	}

	/** Remap all indices from an old palette version to the current 17-colour palette. */
	private migrateFromOldPalette(fromVersion: number): void {
		const mapping = fromVersion < 2 ? V1_TO_CURRENT : V2_TO_CURRENT;
		let changed = false;
		for (const [id, idx] of this.colors) {
			if (idx >= 0 && idx < mapping.length) {
				const newIdx = mapping[idx];
				if (newIdx !== idx) {
					this.colors.set(id, newIdx);
					changed = true;
				}
			} else if (idx > 16) {
				// Any index out of new range → clamp to max
				this.colors.set(id, 16);
				changed = true;
			}
		}
		if (changed) {
			console.log(`[color-store] Migrated session colors from palette v${fromVersion} to v${PALETTE_VERSION}`);
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
