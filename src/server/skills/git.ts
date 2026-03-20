import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface WorktreeResult {
	worktreePath: string;
	branchName: string;
}

/**
 * Create a git worktree on a new branch from HEAD.
 * The worktree is placed as a sibling directory to the repo.
 */
export function createWorktree(repoPath: string, branchName: string): WorktreeResult {
	// Validate repoPath exists — execFileSync with a bad cwd throws a misleading
	// "spawnSync git ENOENT" that looks like git isn't installed
	if (!fs.existsSync(repoPath)) {
		throw new Error(`Cannot create worktree: repoPath does not exist: ${repoPath}`);
	}

	const worktreePath = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt-${branchName}`);

	// Create branch and worktree in one step — uses execFileSync (no shell) to prevent injection
	execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
		cwd: repoPath,
		stdio: "pipe",
	});

	// Push the new branch and set upstream tracking so git-status can report ahead/behind
	// and `git rev-parse @{u}` doesn't emit "fatal: no upstream" errors.
	try {
		execFileSync("git", ["push", "-u", "origin", branchName], {
			cwd: worktreePath,
			stdio: "pipe",
		});
	} catch {
		// Push may fail (no remote, auth issues, offline) — not fatal
	}

	return { worktreePath, branchName };
}

/**
 * Remove a git worktree and optionally delete the branch.
 */
export function cleanupWorktree(
	repoPath: string,
	worktreePath: string,
	branchName?: string,
	deleteBranch = false,
): void {
	if (!fs.existsSync(repoPath)) {
		console.warn(`[git] Cannot clean up worktree: repoPath does not exist: ${repoPath}`);
		return;
	}

	try {
		execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
			cwd: repoPath,
			stdio: "pipe",
		});
	} catch {
		// If remove fails, try prune
		try {
			execFileSync("git", ["worktree", "prune"], { cwd: repoPath, stdio: "pipe" });
		} catch {
			// ignore
		}
	}

	if (deleteBranch && branchName) {
		try {
			execFileSync("git", ["branch", "-D", branchName], { cwd: repoPath, stdio: "pipe" });
		} catch {
			// branch may not exist
		}
	}
}
