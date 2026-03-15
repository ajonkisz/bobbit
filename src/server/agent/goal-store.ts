import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type GoalState = "todo" | "in-progress" | "complete" | "shelved";

export interface PersistedGoal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	/** Markdown spec content (inline) */
	spec: string;
	createdAt: number;
	updatedAt: number;
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-goals.json");

/**
 * Simple JSON file store for goals.
 * Goals persist across server restarts.
 */
export class GoalStore {
	private goals: Map<string, PersistedGoal> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const g of data) {
						if (g.id) {
							this.goals.set(g.id, g);
						}
					}
				}
			}
		} catch (err) {
			console.error("[goal-store] Failed to load persisted goals:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.goals.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[goal-store] Failed to save goals:", err);
		}
	}

	put(goal: PersistedGoal): void {
		this.goals.set(goal.id, goal);
		this.save();
	}

	get(id: string): PersistedGoal | undefined {
		return this.goals.get(id);
	}

	remove(id: string): void {
		this.goals.delete(id);
		this.save();
	}

	getAll(): PersistedGoal[] {
		return Array.from(this.goals.values());
	}

	update(id: string, updates: Partial<Omit<PersistedGoal, "id" | "createdAt">>): boolean {
		const existing = this.goals.get(id);
		if (!existing) return false;
		Object.assign(existing, updates, { updatedAt: Date.now() });
		this.save();
		return true;
	}
}
