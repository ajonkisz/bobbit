import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface PersistedSwarmEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: Array<{
		sessionId: string;
		role: string;
		worktreePath: string;
		branch: string;
		task: string;
		createdAt: number;
	}>;
	maxConcurrent: number;
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-swarms.json");

export class SwarmStore {
	private swarms: Map<string, PersistedSwarmEntry> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.goalId) this.swarms.set(s.goalId, s);
					}
				}
			}
		} catch (err) {
			console.error("[swarm-store] Failed to load:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
			fs.writeFileSync(STORE_FILE, JSON.stringify(Array.from(this.swarms.values()), null, 2), "utf-8");
		} catch (err) {
			console.error("[swarm-store] Failed to save:", err);
		}
	}

	put(entry: PersistedSwarmEntry): void {
		this.swarms.set(entry.goalId, entry);
		this.save();
	}

	get(goalId: string): PersistedSwarmEntry | undefined {
		return this.swarms.get(goalId);
	}

	remove(goalId: string): void {
		this.swarms.delete(goalId);
		this.save();
	}

	getAll(): PersistedSwarmEntry[] {
		return Array.from(this.swarms.values());
	}
}
