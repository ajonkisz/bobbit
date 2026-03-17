import { randomUUID } from "node:crypto";
import { TaskStore, type PersistedTask, type TaskState, type TaskType } from "./task-store.js";

/**
 * Valid state transitions for tasks.
 */
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
	"todo": ["in-progress", "skipped"],
	"in-progress": ["complete", "blocked", "todo"],
	"blocked": ["in-progress", "skipped"],
	"complete": [],
	"skipped": ["todo"],
};

export class TaskManager {
	private store = new TaskStore();

	createTask(goalId: string, opts: {
		title: string;
		type: TaskType;
		parentTaskId?: string;
		spec?: string;
		dependsOn?: string[];
	}): PersistedTask {
		// Validate parent task exists and is not itself a sub-task
		if (opts.parentTaskId) {
			const parent = this.store.get(opts.parentTaskId);
			if (!parent) throw new Error(`Parent task not found: ${opts.parentTaskId}`);
			if (parent.parentTaskId) throw new Error("Sub-tasks cannot have their own sub-tasks (max one level of nesting)");
			if (parent.goalId !== goalId) throw new Error("Parent task belongs to a different goal");
		}

		// Validate dependencies exist
		if (opts.dependsOn) {
			for (const depId of opts.dependsOn) {
				if (!this.store.get(depId)) throw new Error(`Dependency task not found: ${depId}`);
			}
		}

		const now = Date.now();
		const task: PersistedTask = {
			id: randomUUID(),
			goalId,
			parentTaskId: opts.parentTaskId,
			title: opts.title,
			type: opts.type,
			state: "todo",
			spec: opts.spec,
			createdAt: now,
			updatedAt: now,
			dependsOn: opts.dependsOn,
		};

		this.store.put(task);
		return task;
	}

	getTask(id: string): PersistedTask | undefined {
		return this.store.get(id);
	}

	getTasksForGoal(goalId: string): PersistedTask[] {
		return this.store.getByGoalId(goalId);
	}

	getTasksForSession(sessionId: string): PersistedTask[] {
		return this.store.getBySessionId(sessionId);
	}

	updateTask(id: string, updates: {
		title?: string;
		spec?: string;
		dependsOn?: string[];
		assignedSessionId?: string;
	}): boolean {
		const task = this.store.get(id);
		if (!task) return false;

		// Validate dependencies if being updated
		if (updates.dependsOn) {
			for (const depId of updates.dependsOn) {
				if (!this.store.get(depId)) throw new Error(`Dependency task not found: ${depId}`);
			}
			this.checkCircularDeps(id, updates.dependsOn);
		}

		return this.store.update(id, updates);
	}

	deleteTask(id: string): boolean {
		const task = this.store.get(id);
		if (!task) return false;

		// Cascade: delete sub-tasks if this is a parent task
		const subtasks = this.store.getByGoalId(task.goalId).filter(t => t.parentTaskId === id);
		for (const sub of subtasks) {
			this.store.remove(sub.id);
		}

		this.store.remove(id);
		return true;
	}

	deleteTasksForGoal(goalId: string): void {
		const tasks = this.store.getByGoalId(goalId);
		for (const task of tasks) {
			this.store.remove(task.id);
		}
	}

	/**
	 * Assign a task to a session and auto-transition to in-progress.
	 */
	assignTask(taskId: string, sessionId: string): boolean {
		const task = this.store.get(taskId);
		if (!task) return false;

		this.store.update(taskId, { assignedSessionId: sessionId });

		// Auto-transition to in-progress if currently todo
		if (task.state === "todo") {
			this.store.update(taskId, { state: "in-progress" });
		}

		// If this is a sub-task, auto-transition parent to in-progress
		if (task.parentTaskId) {
			const parent = this.store.get(task.parentTaskId);
			if (parent && parent.state === "todo") {
				this.store.update(task.parentTaskId, { state: "in-progress" });
			}
		}

		return true;
	}

	/**
	 * Transition a task to a new state with validation.
	 */
	transitionTask(taskId: string, newState: TaskState): boolean {
		const task = this.store.get(taskId);
		if (!task) return false;

		// Validate transition
		const allowed = VALID_TRANSITIONS[task.state];
		if (!allowed.includes(newState)) {
			throw new Error(`Invalid state transition: ${task.state} → ${newState}`);
		}

		// If completing, validate sub-tasks are done
		if (newState === "complete") {
			const subtasks = this.store.getByGoalId(task.goalId).filter(t => t.parentTaskId === taskId);
			const incomplete = subtasks.filter(t => t.state !== "complete" && t.state !== "skipped");
			if (incomplete.length > 0) {
				throw new Error(`Cannot complete task: ${incomplete.length} sub-task(s) are still incomplete`);
			}
		}

		const updates: Partial<PersistedTask> = { state: newState };
		if (newState === "complete") {
			updates.completedAt = Date.now();
		}

		return this.store.update(taskId, updates);
	}

	/**
	 * Check for circular dependencies. Throws if adding `newDeps` to `taskId` would create a cycle.
	 */
	private checkCircularDeps(taskId: string, newDeps: string[]): void {
		const visited = new Set<string>();

		const walk = (id: string): void => {
			if (id === taskId) throw new Error("Circular dependency detected");
			if (visited.has(id)) return;
			visited.add(id);

			const task = this.store.get(id);
			if (task?.dependsOn) {
				for (const depId of task.dependsOn) {
					walk(depId);
				}
			}
		};

		for (const depId of newDeps) {
			walk(depId);
		}
	}
}
