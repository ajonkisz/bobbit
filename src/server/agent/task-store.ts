import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type TaskType = "code" | "test" | "review";
export type TaskStatus = "backlog" | "in-progress" | "done" | "failed" | "stale";

export interface PersistedTask {
	id: string;
	title: string;
	type: TaskType;
	status: TaskStatus;
	assignee?: string; // session ID
	goalId: string;
	commitSha?: string;
	resultSummary?: string;
	createdAt: number;
	updatedAt: number;
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-tasks.json");

/**
 * Simple JSON file store for tasks.
 * Tasks persist across server restarts.
 * Follows the same load-on-construct, write-on-mutate pattern as GoalStore.
 */
export class TaskStore {
	private tasks: Map<string, PersistedTask> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const t of data) {
						if (t.id) {
							this.tasks.set(t.id, t);
						}
					}
				}
			}
		} catch (err) {
			console.error("[task-store] Failed to load persisted tasks:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.tasks.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[task-store] Failed to save tasks:", err);
		}
	}

	put(task: PersistedTask): void {
		this.tasks.set(task.id, task);
		this.save();
	}

	get(id: string): PersistedTask | undefined {
		return this.tasks.get(id);
	}

	remove(id: string): boolean {
		const existed = this.tasks.delete(id);
		if (existed) this.save();
		return existed;
	}

	getAll(): PersistedTask[] {
		return Array.from(this.tasks.values());
	}

	getByGoalId(goalId: string): PersistedTask[] {
		return Array.from(this.tasks.values()).filter((t) => t.goalId === goalId);
	}

	update(id: string, updates: Partial<Omit<PersistedTask, "id" | "goalId" | "createdAt">>): boolean {
		const existing = this.tasks.get(id);
		if (!existing) return false;
		// Strip undefined values to avoid overwriting existing fields
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.save();
		return true;
	}
}
