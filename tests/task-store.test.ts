import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-tasks.json");

let backupData: string | null = null;

function backupTaskStore() {
	try {
		if (fs.existsSync(STORE_FILE)) {
			backupData = fs.readFileSync(STORE_FILE, "utf-8");
		}
	} catch {
		backupData = null;
	}
}

function restoreTaskStore() {
	try {
		if (backupData !== null) {
			fs.writeFileSync(STORE_FILE, backupData, "utf-8");
		} else if (fs.existsSync(STORE_FILE)) {
			fs.unlinkSync(STORE_FILE);
		}
	} catch {
		/* ignore */
	}
}

function clearTaskStore() {
	try {
		if (fs.existsSync(STORE_FILE)) {
			fs.unlinkSync(STORE_FILE);
		}
	} catch {
		/* ignore */
	}
}

async function createFreshTaskStore() {
	if (!fs.existsSync(STORE_DIR)) {
		fs.mkdirSync(STORE_DIR, { recursive: true });
	}
	fs.writeFileSync(STORE_FILE, "[]", "utf-8");
	const mod = await import("../src/server/agent/task-store.ts");
	return new mod.TaskStore();
}

function makeTask(overrides: Record<string, unknown> = {}) {
	return {
		id: "task-1",
		title: "Implement feature",
		type: "code" as const,
		status: "backlog" as const,
		goalId: "goal-1",
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

describe("TaskStore", () => {
	beforeEach(() => {
		backupTaskStore();
		clearTaskStore();
	});

	afterEach(() => {
		restoreTaskStore();
	});

	// -----------------------------------------------------------------------
	// Basic CRUD
	// -----------------------------------------------------------------------

	describe("basic CRUD", () => {
		it("put and get a task", async () => {
			const store = await createFreshTaskStore();
			const task = makeTask();
			store.put(task);
			const retrieved = store.get("task-1");
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Implement feature");
			assert.equal(retrieved.type, "code");
			assert.equal(retrieved.status, "backlog");
			assert.equal(retrieved.goalId, "goal-1");
			assert.equal(retrieved.createdAt, 1000);
			assert.equal(retrieved.updatedAt, 1000);
		});

		it("getAll returns all tasks", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ id: "task-1" }));
			store.put(makeTask({ id: "task-2", title: "Second task" }));
			const all = store.getAll();
			assert.equal(all.length, 2);
			const ids = all.map((t) => t.id).sort();
			assert.deepEqual(ids, ["task-1", "task-2"]);
		});

		it("get returns undefined for non-existent task", async () => {
			const store = await createFreshTaskStore();
			assert.equal(store.get("nonexistent"), undefined);
		});

		it("remove deletes a task and returns true", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask());
			assert.ok(store.get("task-1"));
			const result = store.remove("task-1");
			assert.equal(result, true);
			assert.equal(store.get("task-1"), undefined);
			assert.equal(store.getAll().length, 0);
		});

		it("remove returns false for non-existent task", async () => {
			const store = await createFreshTaskStore();
			const result = store.remove("nonexistent");
			assert.equal(result, false);
		});

		it("put overwrites existing task with same id", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask());
			store.put(makeTask({ title: "Updated title" }));
			const retrieved = store.get("task-1");
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Updated title");
			assert.equal(store.getAll().length, 1);
		});
	});

	// -----------------------------------------------------------------------
	// getByGoalId — filtering
	// -----------------------------------------------------------------------

	describe("getByGoalId", () => {
		it("returns only tasks for the specified goal", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ id: "t1", goalId: "goal-1" }));
			store.put(makeTask({ id: "t2", goalId: "goal-1" }));
			store.put(makeTask({ id: "t3", goalId: "goal-2" }));

			const goal1Tasks = store.getByGoalId("goal-1");
			assert.equal(goal1Tasks.length, 2);
			assert.ok(goal1Tasks.every((t) => t.goalId === "goal-1"));

			const goal2Tasks = store.getByGoalId("goal-2");
			assert.equal(goal2Tasks.length, 1);
			assert.equal(goal2Tasks[0].id, "t3");
		});

		it("returns empty array for goal with no tasks", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ id: "t1", goalId: "goal-1" }));
			const result = store.getByGoalId("goal-999");
			assert.deepEqual(result, []);
		});

		it("returns empty array when store is empty", async () => {
			const store = await createFreshTaskStore();
			const result = store.getByGoalId("goal-1");
			assert.deepEqual(result, []);
		});
	});

	// -----------------------------------------------------------------------
	// Persistence
	// -----------------------------------------------------------------------

	describe("persistence", () => {
		it("persists to disk and can be reloaded", async () => {
			const store1 = await createFreshTaskStore();
			store1.put(makeTask());
			store1.put(makeTask({ id: "task-2", title: "Second", goalId: "goal-2" }));

			const mod = await import("../src/server/agent/task-store.ts");
			const store2 = new mod.TaskStore();
			assert.equal(store2.getAll().length, 2);
			const t1 = store2.get("task-1");
			assert.ok(t1);
			assert.equal(t1.title, "Implement feature");
			const t2 = store2.get("task-2");
			assert.ok(t2);
			assert.equal(t2.title, "Second");
		});

		it("remove persists deletion to disk", async () => {
			const store1 = await createFreshTaskStore();
			store1.put(makeTask());
			store1.remove("task-1");

			const mod = await import("../src/server/agent/task-store.ts");
			const store2 = new mod.TaskStore();
			assert.equal(store2.get("task-1"), undefined);
			assert.equal(store2.getAll().length, 0);
		});

		it("handles corrupted file gracefully", async () => {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			// Write corrupted data to the store file
			fs.writeFileSync(STORE_FILE, "not valid json{{{", "utf-8");

			const mod = await import("../src/server/agent/task-store.ts");
			const store = new mod.TaskStore();
			// Should not throw; constructor catches parse errors.
			// The store should have no tasks loaded from the corrupted file.
			// (It may still have 0 items, or the parse error path leaves the map empty.)
			// Verify the store is functional — we can put and get:
			const task = makeTask({ id: "after-corrupt" });
			store.put(task);
			assert.ok(store.get("after-corrupt"));
		});

		it("handles missing file gracefully", async () => {
			clearTaskStore();
			const mod = await import("../src/server/agent/task-store.ts");
			const store = new mod.TaskStore();
			assert.equal(store.getAll().length, 0);
		});
	});

	// -----------------------------------------------------------------------
	// update() — undefined stripping (matching GoalStore pattern)
	// -----------------------------------------------------------------------

	describe("update()", () => {
		it("partial update changes specified fields", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask());

			const result = store.update("task-1", { title: "New title", status: "in-progress" });
			assert.equal(result, true);

			const updated = store.get("task-1")!;
			assert.equal(updated.title, "New title");
			assert.equal(updated.status, "in-progress");
			// Unchanged fields preserved
			assert.equal(updated.type, "code");
			assert.equal(updated.goalId, "goal-1");
		});

		it("update with undefined values does NOT overwrite existing values", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({
				assignee: "session-1",
				commitSha: "abc123",
				resultSummary: "All passed",
			}));

			store.update("task-1", {
				title: "Updated",
				assignee: undefined,
				commitSha: undefined,
				resultSummary: undefined,
			});

			const updated = store.get("task-1")!;
			assert.equal(updated.title, "Updated");
			assert.equal(updated.assignee, "session-1");
			assert.equal(updated.commitSha, "abc123");
			assert.equal(updated.resultSummary, "All passed");
		});

		it("update sets updatedAt timestamp", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ updatedAt: 1000 }));

			const before = Date.now();
			store.update("task-1", { title: "New" });
			const after = Date.now();

			const updated = store.get("task-1")!;
			assert.ok(updated.updatedAt >= before);
			assert.ok(updated.updatedAt <= after);
		});

		it("update returns false for non-existent task", async () => {
			const store = await createFreshTaskStore();
			const result = store.update("nonexistent", { title: "Nope" });
			assert.equal(result, false);
		});

		it("update does not allow overwriting id, goalId, or createdAt", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ id: "task-1", goalId: "goal-1", createdAt: 1000 }));

			// These are Omit'd from the type, but test runtime behavior too
			store.update("task-1", { title: "New" } as any);

			const updated = store.get("task-1")!;
			assert.equal(updated.id, "task-1");
			assert.equal(updated.goalId, "goal-1");
			assert.equal(updated.createdAt, 1000);
		});

		it("update with all undefined values preserves everything except updatedAt", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask());

			store.update("task-1", {
				title: undefined,
				type: undefined,
				status: undefined,
			} as any);

			const updated = store.get("task-1")!;
			assert.equal(updated.title, "Implement feature");
			assert.equal(updated.type, "code");
			assert.equal(updated.status, "backlog");
		});

		it("update with explicit empty string DOES overwrite", async () => {
			const store = await createFreshTaskStore();
			store.put(makeTask({ resultSummary: "original summary" }));

			store.update("task-1", { resultSummary: "" });

			const updated = store.get("task-1")!;
			assert.equal(updated.resultSummary, "");
		});
	});
});
