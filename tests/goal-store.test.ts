import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// We need to override the store file location before importing GoalStore.
// GoalStore reads STORE_FILE at module level, so we mock fs operations
// to redirect to a temp file.

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-goals.json");

// Back up and restore the real goals file around tests
let backupData: string | null = null;

function backupGoalStore() {
	try {
		if (fs.existsSync(STORE_FILE)) {
			backupData = fs.readFileSync(STORE_FILE, "utf-8");
		}
	} catch {
		backupData = null;
	}
}

function restoreGoalStore() {
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

function clearGoalStore() {
	try {
		if (fs.existsSync(STORE_FILE)) {
			fs.unlinkSync(STORE_FILE);
		}
	} catch {
		/* ignore */
	}
}

// We need a fresh import each time to reset the in-memory Map.
// node:test doesn't have jest-style module reset, so we use a helper.
async function createFreshGoalStore() {
	// Write empty array to ensure clean state on disk
	if (!fs.existsSync(STORE_DIR)) {
		fs.mkdirSync(STORE_DIR, { recursive: true });
	}
	fs.writeFileSync(STORE_FILE, "[]", "utf-8");

	// Dynamic import with cache-busting query param doesn't work for .ts with tsx,
	// so we construct a new instance directly by importing the class.
	// Since the constructor calls load(), and we cleared the file, it'll be empty.
	const mod = await import("../src/server/agent/goal-store.ts");
	return new mod.GoalStore();
}

function makeGoal(overrides: Record<string, unknown> = {}) {
	return {
		id: "goal-1",
		title: "Implement feature X",
		cwd: "/tmp/project",
		state: "todo" as const,
		spec: "# Feature X\nBuild the thing",
		createdAt: 1000,
		updatedAt: 1000,
		...overrides,
	};
}

describe("GoalStore", () => {
	beforeEach(() => {
		backupGoalStore();
		clearGoalStore();
	});

	afterEach(() => {
		restoreGoalStore();
	});

	// -----------------------------------------------------------------------
	// Basic CRUD
	// -----------------------------------------------------------------------

	describe("basic CRUD", () => {
		it("put and get a goal", async () => {
			const store = await createFreshGoalStore();
			const goal = makeGoal();
			store.put(goal);
			const retrieved = store.get("goal-1");
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Implement feature X");
			assert.equal(retrieved.cwd, "/tmp/project");
			assert.equal(retrieved.state, "todo");
			assert.equal(retrieved.spec, "# Feature X\nBuild the thing");
		});

		it("getAll returns all goals", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({ id: "goal-1" }));
			store.put(makeGoal({ id: "goal-2", title: "Second goal" }));
			const all = store.getAll();
			assert.equal(all.length, 2);
			const ids = all.map((g) => g.id).sort();
			assert.deepEqual(ids, ["goal-1", "goal-2"]);
		});

		it("get returns undefined for non-existent goal", async () => {
			const store = await createFreshGoalStore();
			assert.equal(store.get("nonexistent"), undefined);
		});

		it("remove deletes a goal", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal());
			assert.ok(store.get("goal-1"));
			store.remove("goal-1");
			assert.equal(store.get("goal-1"), undefined);
			assert.equal(store.getAll().length, 0);
		});

		it("remove is idempotent for non-existent goal", async () => {
			const store = await createFreshGoalStore();
			// Should not throw
			store.remove("nonexistent");
			assert.equal(store.getAll().length, 0);
		});

		it("persists to disk and can be reloaded", async () => {
			const store1 = await createFreshGoalStore();
			store1.put(makeGoal());

			// Create a new store instance that loads from the same file
			const mod = await import("../src/server/agent/goal-store.ts");
			const store2 = new mod.GoalStore();
			const retrieved = store2.get("goal-1");
			assert.ok(retrieved);
			assert.equal(retrieved.title, "Implement feature X");
		});
	});

	// -----------------------------------------------------------------------
	// update() — undefined stripping (the critical fix)
	// -----------------------------------------------------------------------

	describe("update() undefined stripping", () => {
		it("partial update with only title does NOT wipe other fields", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal());

			const result = store.update("goal-1", { title: "New title" });
			assert.equal(result, true);

			const updated = store.get("goal-1")!;
			assert.equal(updated.title, "New title");
			// These must NOT be wiped
			assert.equal(updated.cwd, "/tmp/project");
			assert.equal(updated.state, "todo");
			assert.equal(updated.spec, "# Feature X\nBuild the thing");
		});

		it("update with undefined values does NOT overwrite existing values", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({
				worktreePath: "/tmp/wt",
				branch: "feat/x",
				repoPath: "/tmp/repo",
			}));

			// Pass undefined for fields that already have values
			store.update("goal-1", {
				title: "Updated title",
				worktreePath: undefined,
				branch: undefined,
				repoPath: undefined,
			});

			const updated = store.get("goal-1")!;
			assert.equal(updated.title, "Updated title");
			// undefined values must be stripped — existing values preserved
			assert.equal(updated.worktreePath, "/tmp/wt");
			assert.equal(updated.branch, "feat/x");
			assert.equal(updated.repoPath, "/tmp/repo");
		});

		it("update with explicit empty string DOES overwrite", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({ spec: "original spec" }));

			store.update("goal-1", { spec: "" });

			const updated = store.get("goal-1")!;
			assert.equal(updated.spec, "");
		});

		it("update with explicit false boolean DOES overwrite", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({ swarm: true }));

			store.update("goal-1", { swarm: false });

			const updated = store.get("goal-1")!;
			assert.equal(updated.swarm, false);
		});

		it("update with explicit null overwrites the field", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({
				worktreePath: "/tmp/wt",
				branch: "feat/x",
			}));

			// null is not undefined, so it should pass through the filter
			store.update("goal-1", {
				worktreePath: null as any,
				branch: null as any,
			});

			const updated = store.get("goal-1")!;
			// null should overwrite (it's not undefined)
			assert.equal(updated.worktreePath, null);
			assert.equal(updated.branch, null);
		});

		it("update sets updatedAt timestamp", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({ updatedAt: 1000 }));

			const before = Date.now();
			store.update("goal-1", { title: "New" });
			const after = Date.now();

			const updated = store.get("goal-1")!;
			assert.ok(updated.updatedAt >= before);
			assert.ok(updated.updatedAt <= after);
		});

		it("update returns false for non-existent goal", async () => {
			const store = await createFreshGoalStore();
			const result = store.update("nonexistent", { title: "Nope" });
			assert.equal(result, false);
		});

		it("update does not allow overwriting id or createdAt", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal({ id: "goal-1", createdAt: 1000 }));

			// TypeScript prevents this at compile time, but we test runtime behavior
			store.update("goal-1", { title: "New" } as any);

			const updated = store.get("goal-1")!;
			assert.equal(updated.id, "goal-1");
			assert.equal(updated.createdAt, 1000);
		});

		it("update with all undefined values preserves everything except updatedAt", async () => {
			const store = await createFreshGoalStore();
			store.put(makeGoal());

			store.update("goal-1", {
				title: undefined,
				cwd: undefined,
				state: undefined,
				spec: undefined,
			} as any);

			const updated = store.get("goal-1")!;
			assert.equal(updated.title, "Implement feature X");
			assert.equal(updated.cwd, "/tmp/project");
			assert.equal(updated.state, "todo");
			assert.equal(updated.spec, "# Feature X\nBuild the thing");
		});
	});
});
