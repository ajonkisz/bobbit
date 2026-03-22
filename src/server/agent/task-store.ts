import fs from "node:fs";
import path from "node:path";
import { piDir } from "../pi-dir.js";

export type TaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";

export interface PersistedTask {
	id: string;
	goalId: string;
	parentTaskId?: string;
	title: string;
	type: string;
	state: TaskState;
	assignedSessionId?: string;
	spec?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	dependsOn?: string[];
	commitSha?: string;
	resultSummary?: string;
	/** Workflow artifact ID this task should produce (0 or 1). */
	workflowArtifactId?: string;
	/** Workflow artifact IDs whose accepted content to inject when prompting the agent. */
	inputArtifactIds?: string[];
}

const STORE_DIR = piDir();
const STORE_FILE = path.join(STORE_DIR, "gateway-tasks.json");

/**
 * Simple JSON file store for tasks.
 * Tasks persist across server restarts.
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
						if (t.id && t.goalId && t.title && t.type && t.state) {
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

	remove(id: string): void {
		this.tasks.delete(id);
		this.save();
	}

	removeMany(ids: string[]): void {
		for (const id of ids) {
			this.tasks.delete(id);
		}
		if (ids.length > 0) this.save();
	}

	getAll(): PersistedTask[] {
		return Array.from(this.tasks.values());
	}

	getByGoalId(goalId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.goalId === goalId);
	}

	getBySessionId(sessionId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.assignedSessionId === sessionId);
	}

	getByParentTaskId(parentTaskId: string): PersistedTask[] {
		return this.getAll().filter((t) => t.parentTaskId === parentTaskId);
	}
}
