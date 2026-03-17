import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { GoalStore, type GoalState, type PersistedGoal } from "./goal-store.js";
import { createWorktree, cleanupWorktree } from "../workflows/git.js";

/**
 * Sanitize a goal title into a valid git branch name.
 * Lowercase, replace non-alphanumeric with hyphens, trim, truncate.
 */
function toBranchName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40) || "goal";
}

/** Check if a directory is inside a git repository. */
function isGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/** Get the git repo root for a directory. */
function getRepoRoot(cwd: string): string {
	return execSync("git rev-parse --show-toplevel", { cwd, stdio: "pipe" }).toString().trim();
}

export class GoalManager {
	private store = new GoalStore();

	createGoal(title: string, cwd: string, spec = "", swarm = false): PersistedGoal {
		const now = Date.now();
		const id = randomUUID();

		let worktreePath: string | undefined;
		let branch: string | undefined;
		let repoPath: string | undefined;
		let goalCwd = cwd;

		// Create a git worktree if the cwd is a git repo (only for swarm goals)
		if (swarm && isGitRepo(cwd)) {
			repoPath = getRepoRoot(cwd);
			branch = `goal/${toBranchName(title)}-${id.slice(0, 8)}`;
			try {
				const result = createWorktree(repoPath, branch);
				worktreePath = result.worktreePath;
				goalCwd = worktreePath;
				console.log(`[goal-manager] Created worktree for goal "${title}": ${worktreePath} (branch: ${branch})`);
			} catch (err) {
				// Worktree creation failed — fall back to shared cwd
				console.error(`[goal-manager] Failed to create worktree for goal "${title}":`, err);
				worktreePath = undefined;
				branch = undefined;
				repoPath = undefined;
			}
		}

		const goal: PersistedGoal = {
			id,
			title,
			cwd: goalCwd,
			state: "todo",
			spec,
			createdAt: now,
			updatedAt: now,
			worktreePath,
			branch,
			repoPath,
			swarm,
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

	updateGoal(id: string, updates: { title?: string; cwd?: string; state?: GoalState; spec?: string; swarm?: boolean; repoPath?: string; branch?: string }): boolean {
		return this.store.update(id, updates);
	}

	deleteGoal(id: string): boolean {
		const goal = this.store.get(id);
		if (goal?.swarm) {
			console.warn(`[goal-manager] Deleting swarm goal "${goal.title}" — ensure no active swarm sessions remain (cannot check from GoalManager)`);
		}
		if (goal?.worktreePath && goal?.repoPath) {
			try {
				cleanupWorktree(goal.repoPath, goal.worktreePath, goal.branch, true);
				console.log(`[goal-manager] Cleaned up worktree for goal "${goal.title}": ${goal.worktreePath}`);
			} catch (err) {
				console.error(`[goal-manager] Failed to clean up worktree for goal "${goal.title}":`, err);
			}
		}
		this.store.remove(id);
		return true;
	}
}
