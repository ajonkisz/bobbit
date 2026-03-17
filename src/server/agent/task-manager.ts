import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { TaskStore, type TaskType, type TaskStatus, type PersistedTask } from "./task-store.js";

/**
 * Run `git rev-parse HEAD` in the given directory to get the current commit SHA.
 */
export function getGoalBranchHead(goalCwd: string): string {
	const result = execSync("git rev-parse HEAD", { cwd: goalCwd, shell: true as unknown as string });
	return result.toString().trim();
}

/**
 * CRUD manager for structured tasks.
 * Wraps TaskStore with convenience methods.
 */
export class TaskManager {
	private store = new TaskStore();

	create(goalId: string, title: string, type: TaskType): PersistedTask {
		const now = Date.now();
		const task: PersistedTask = {
			id: randomUUID(),
			title,
			type,
			status: "backlog",
			goalId,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(task);
		return task;
	}

	update(id: string, updates: Partial<Omit<PersistedTask, "id" | "goalId" | "createdAt">>): PersistedTask | undefined {
		const ok = this.store.update(id, updates);
		if (!ok) return undefined;
		return this.store.get(id);
	}

	delete(id: string): boolean {
		return this.store.remove(id);
	}

	getById(id: string): PersistedTask | undefined {
		return this.store.get(id);
	}

	getByGoalId(goalId: string): PersistedTask[] {
		return this.store.getByGoalId(goalId);
	}

	listAll(): PersistedTask[] {
		return this.store.getAll();
	}

	/**
	 * Mark done test/review tasks as stale when the goal branch HEAD advances.
	 * A task is stale if it has a commitSha that differs from the new HEAD.
	 * Returns the list of tasks that were marked stale.
	 */
	markStaleIfNeeded(goalId: string, newCommitSha: string): PersistedTask[] {
		const tasks = this.store.getByGoalId(goalId);
		const staled: PersistedTask[] = [];

		for (const task of tasks) {
			if (
				task.status === "done" &&
				(task.type === "test" || task.type === "review") &&
				task.commitSha &&
				task.commitSha !== newCommitSha
			) {
				const updated = this.update(task.id, { status: "stale" });
				if (updated) staled.push(updated);
			}
		}

		return staled;
	}
}
