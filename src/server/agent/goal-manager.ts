import { randomUUID } from "node:crypto";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";

export class GoalManager {
	private store = new GoalStore();

	createGoal(title: string, cwd: string, spec = ""): PersistedGoal {
		const now = Date.now();
		const goal: PersistedGoal = {
			id: randomUUID(),
			title,
			cwd,
			state: "todo",
			spec,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(goal);
		return goal;
	}

	getGoal(id: string): PersistedGoal | undefined {
		return this.store.get(id);
	}

	listGoals(): PersistedGoal[] {
		return this.store.getAll();
	}

	updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string }): boolean {
		return this.store.update(id, updates);
	}

	deleteGoal(id: string): boolean {
		this.store.remove(id);
		return true;
	}
}
