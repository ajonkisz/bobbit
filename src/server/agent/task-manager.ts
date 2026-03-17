import { randomUUID } from "node:crypto";
import { TaskStore, type TaskType, type TaskStatus, type PersistedTask } from "./task-store.js";

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
}
