import { execFileSync } from "node:child_process";
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
	const worktreePath = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt-${branchName}`);

	// Create branch and worktree in one step — uses execFileSync (no shell) to prevent injection
	execFileSync("git", ["worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
		cwd: repoPath,
		stdio: "pipe",
	});

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
