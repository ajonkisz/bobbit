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

async function createFreshTaskManager() {
	if (!fs.existsSync(STORE_DIR)) {
		fs.mkdirSync(STORE_DIR, { recursive: true });
	}
	fs.writeFileSync(STORE_FILE, "[]", "utf-8");
	const mod = await import("../src/server/agent/task-manager.ts");
	return new mod.TaskManager();
}

describe("TaskManager", () => {
	beforeEach(() => {
		backupTaskStore();
		clearTaskStore();
	});

	afterEach(() => {
		restoreTaskStore();
	});

	// -----------------------------------------------------------------------
	// create()
	// -----------------------------------------------------------------------

	describe("create()", () => {
		it("creates a task with correct fields", async () => {
			const mgr = await createFreshTaskManager();
			const before = Date.now();
			const task = mgr.create("goal-1", "Write tests", "test");
			const after = Date.now();

			assert.ok(task.id, "should have an id");
			assert.equal(task.title, "Write tests");
			assert.equal(task.type, "test");
			assert.equal(task.status, "backlog");
			assert.equal(task.goalId, "goal-1");
			assert.ok(task.createdAt >= before);
			assert.ok(task.createdAt <= after);
			assert.ok(task.updatedAt >= before);
			assert.ok(task.updatedAt <= after);
		});

		it("creates tasks with valid type 'code'", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Code task", "code");
			assert.equal(task.type, "code");
		});

		it("creates tasks with valid type 'review'", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Review task", "review");
			assert.equal(task.type, "review");
		});

		it("generates unique IDs for each task", async () => {
			const mgr = await createFreshTaskManager();
			const t1 = mgr.create("goal-1", "Task 1", "code");
			const t2 = mgr.create("goal-1", "Task 2", "code");
			const t3 = mgr.create("goal-1", "Task 3", "test");
			assert.notEqual(t1.id, t2.id);
			assert.notEqual(t2.id, t3.id);
			assert.notEqual(t1.id, t3.id);
		});

		it("created task is retrievable", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Test task", "test");
			const retrieved = mgr.getById(task.id);
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Test task");
		});
	});

	// -----------------------------------------------------------------------
	// update() and delete()
	// -----------------------------------------------------------------------

	describe("update() and delete()", () => {
		it("update returns the updated task", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Original", "code");
			const updated = mgr.update(task.id, { title: "Updated", status: "in-progress" });
			assert.ok(updated);
			assert.equal(updated.title, "Updated");
			assert.equal(updated.status, "in-progress");
		});

		it("update returns undefined for non-existent task", async () => {
			const mgr = await createFreshTaskManager();
			const result = mgr.update("nonexistent", { title: "Nope" });
			assert.equal(result, undefined);
		});

		it("delete returns true for existing task", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "To delete", "code");
			const result = mgr.delete(task.id);
			assert.equal(result, true);
			assert.equal(mgr.getById(task.id), undefined);
		});

		it("delete returns false for non-existent task", async () => {
			const mgr = await createFreshTaskManager();
			const result = mgr.delete("nonexistent");
			assert.equal(result, false);
		});
	});

	// -----------------------------------------------------------------------
	// getByGoalId() and listAll()
	// -----------------------------------------------------------------------

	describe("query methods", () => {
		it("getByGoalId returns filtered tasks", async () => {
			const mgr = await createFreshTaskManager();
			mgr.create("goal-1", "Task A", "code");
			mgr.create("goal-1", "Task B", "test");
			mgr.create("goal-2", "Task C", "review");

			const goal1Tasks = mgr.getByGoalId("goal-1");
			assert.equal(goal1Tasks.length, 2);

			const goal2Tasks = mgr.getByGoalId("goal-2");
			assert.equal(goal2Tasks.length, 1);
		});

		it("listAll returns all tasks across goals", async () => {
			const mgr = await createFreshTaskManager();
			mgr.create("goal-1", "Task A", "code");
			mgr.create("goal-2", "Task B", "test");
			const all = mgr.listAll();
			assert.equal(all.length, 2);
		});
	});

	// -----------------------------------------------------------------------
	// markStaleIfNeeded()
	// -----------------------------------------------------------------------

	describe("markStaleIfNeeded()", () => {
		it("marks done test tasks as stale when commitSha differs", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Run tests", "test");
			mgr.update(task.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 1);
			assert.equal(staled[0].id, task.id);
			assert.equal(staled[0].status, "stale");

			// Verify persisted
			const retrieved = mgr.getById(task.id);
			assert.equal(retrieved?.status, "stale");
		});

		it("marks done review tasks as stale when commitSha differs", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Code review", "review");
			mgr.update(task.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 1);
			assert.equal(staled[0].status, "stale");
		});

		it("does NOT mark done code tasks as stale", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Implement feature", "code");
			mgr.update(task.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 0);

			const retrieved = mgr.getById(task.id);
			assert.equal(retrieved?.status, "done");
		});

		it("does NOT mark tasks with matching commitSha as stale", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Run tests", "test");
			mgr.update(task.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "abc123");
			assert.equal(staled.length, 0);

			const retrieved = mgr.getById(task.id);
			assert.equal(retrieved?.status, "done");
		});

		it("does NOT mark non-done tasks as stale", async () => {
			const mgr = await createFreshTaskManager();
			const t1 = mgr.create("goal-1", "Test backlog", "test");
			// Leave as backlog (default)
			const t2 = mgr.create("goal-1", "Test in progress", "test");
			mgr.update(t2.id, { status: "in-progress", commitSha: "abc123" });
			const t3 = mgr.create("goal-1", "Test failed", "test");
			mgr.update(t3.id, { status: "failed", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 0);
		});

		it("does NOT mark tasks without commitSha as stale", async () => {
			const mgr = await createFreshTaskManager();
			const task = mgr.create("goal-1", "Run tests", "test");
			mgr.update(task.id, { status: "done" }); // No commitSha

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 0);
		});

		it("only affects tasks for the specified goal", async () => {
			const mgr = await createFreshTaskManager();
			const t1 = mgr.create("goal-1", "Test for goal 1", "test");
			mgr.update(t1.id, { status: "done", commitSha: "abc123" });
			const t2 = mgr.create("goal-2", "Test for goal 2", "test");
			mgr.update(t2.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 1);
			assert.equal(staled[0].id, t1.id);

			// goal-2 task should still be done
			const t2Retrieved = mgr.getById(t2.id);
			assert.equal(t2Retrieved?.status, "done");
		});

		it("marks multiple eligible tasks as stale", async () => {
			const mgr = await createFreshTaskManager();
			const t1 = mgr.create("goal-1", "Test 1", "test");
			mgr.update(t1.id, { status: "done", commitSha: "abc123" });
			const t2 = mgr.create("goal-1", "Review 1", "review");
			mgr.update(t2.id, { status: "done", commitSha: "abc123" });
			const t3 = mgr.create("goal-1", "Code 1", "code");
			mgr.update(t3.id, { status: "done", commitSha: "abc123" });

			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.equal(staled.length, 2); // test + review, NOT code
			const staledIds = staled.map((t) => t.id).sort();
			assert.deepEqual(staledIds, [t1.id, t2.id].sort());
		});

		it("returns empty array when no tasks exist for goal", async () => {
			const mgr = await createFreshTaskManager();
			const staled = mgr.markStaleIfNeeded("goal-1", "def456");
			assert.deepEqual(staled, []);
		});
	});
});
