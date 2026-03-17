import { gatewayFetch } from "./api.js";
import { setHashRoute } from "./routing.js";
import type { Goal } from "./state.js";

// ============================================================================
// TYPES
// ============================================================================

export interface CommitInfo {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
}

export interface TaskInfo {
	id: string;
	title: string;
	type: "code" | "test" | "review";
	status: "backlog" | "in-progress" | "done" | "failed" | "stale";
	assignee?: string;
	goalId: string;
	commitSha?: string;
	resultSummary?: string;
	createdAt: number;
	updatedAt: number;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

export async function fetchGoalCommits(goalId: string, limit = 20): Promise<CommitInfo[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/commits?limit=${limit}`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.commits || [];
	} catch {
		return [];
	}
}

export async function fetchGoalTasks(goalId: string): Promise<TaskInfo[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/tasks`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.tasks || [];
	} catch {
		return [];
	}
}

// ============================================================================
// COMMIT TIMELINE RENDERING
// ============================================================================

type BadgeStatus = "pass" | "fail" | "stale" | "pending";

interface CommitBadges {
	tests?: BadgeStatus;
	review?: BadgeStatus;
}

/**
 * Derive badge statuses for each commit based on task completions.
 * A task completed at commitSha X shows on that commit.
 * If a newer commit exists with no task of that type, older results are stale.
 */
function deriveBadges(commits: CommitInfo[], tasks: TaskInfo[]): Map<string, CommitBadges> {
	const badges = new Map<string, CommitBadges>();
	if (commits.length === 0) return badges;

	// Initialize all commits with empty badges
	for (const c of commits) {
		badges.set(c.sha, {});
	}

	// Group tasks by type and commit
	const testTasks = tasks.filter(t => t.type === "test" && t.commitSha);
	const reviewTasks = tasks.filter(t => t.type === "review" && t.commitSha);

	// Build a sha->index map for ordering (0 = newest)
	const shaIndex = new Map<string, number>();
	commits.forEach((c, i) => shaIndex.set(c.sha, i));

	// Apply test task statuses
	for (const task of testTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.status === "done") b.tests = "pass";
		else if (task.status === "failed") b.tests = "fail";
		else if (task.status === "stale") b.tests = "stale";
		else if (task.status === "in-progress") b.tests = "pending";
	}

	// Apply review task statuses
	for (const task of reviewTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.status === "done") b.review = "pass";
		else if (task.status === "failed") b.review = "fail";
		else if (task.status === "stale") b.review = "stale";
		else if (task.status === "in-progress") b.review = "pending";
	}

	return badges;
}

function formatRelativeTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	const diffMs = now - then;
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	return `${diffDays}d ago`;
}

function badgeHtml(label: string, status: BadgeStatus): string {
	const icons: Record<BadgeStatus, string> = {
		pass: "✓",
		fail: "✗",
		stale: "⟳",
		pending: "⏳",
	};
	return `<span class="commit-badge commit-badge--${status}" title="${label}: ${status}">${icons[status]} ${label}</span>`;
}

export function renderCommitTimeline(commits: CommitInfo[], tasks: TaskInfo[]): string {
	if (commits.length === 0) {
		return `<div class="commit-timeline-empty">No commits found on this branch.</div>`;
	}

	const badges = deriveBadges(commits, tasks);

	const items = commits.map((commit, index) => {
		const isHead = index === 0;
		const dotClass = isHead ? "commit-dot commit-dot--head" : "commit-dot";
		const b = badges.get(commit.sha) || {};

		const badgesHtml: string[] = [];
		if (b.tests) badgesHtml.push(badgeHtml("Tests", b.tests));
		if (b.review) badgesHtml.push(badgeHtml("Review", b.review));

		return `
			<div class="commit-item" data-sha="${commit.sha}">
				<div class="${dotClass}"></div>
				<div class="commit-content">
					<div class="commit-header">
						<code class="commit-sha">${commit.shortSha}</code>
						${badgesHtml.length > 0 ? `<span class="commit-badges">${badgesHtml.join("")}</span>` : ""}
						<span class="commit-time">${formatRelativeTime(commit.timestamp)}</span>
					</div>
					<div class="commit-message">${escapeHtml(commit.message)}</div>
					<div class="commit-author">${escapeHtml(commit.author)}</div>
				</div>
			</div>`;
	}).join("");

	return `<div class="commit-timeline">${items}</div>`;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================================================
// FULL DASHBOARD RENDER
// ============================================================================

export async function renderGoalDashboard(goalId: string, container: HTMLElement): Promise<void> {
	container.innerHTML = `<div class="goal-dashboard-loading">Loading dashboard...</div>`;

	// Fetch goal, commits, and tasks in parallel
	const [goalRes, commits, tasks] = await Promise.all([
		gatewayFetch(`/api/goals/${goalId}`).then(r => r.ok ? r.json() : null),
		fetchGoalCommits(goalId),
		fetchGoalTasks(goalId),
	]);

	if (!goalRes) {
		container.innerHTML = `<div class="goal-dashboard-error">Goal not found. <a href="#/">Back to sessions</a></div>`;
		return;
	}

	const goal = goalRes as Goal;

	// State indicator
	const stateColors: Record<string, string> = {
		"todo": "#6b7280",
		"in-progress": "#3b82f6",
		"complete": "#22c55e",
		"done": "#22c55e",
		"shelved": "#f59e0b",
	};
	const stateColor = stateColors[goal.state] || "#6b7280";

	container.innerHTML = `
		<div class="goal-dashboard">
			<div class="goal-dashboard-nav">
				<button class="goal-dashboard-back" title="Back to sessions">← Back</button>
				<div class="goal-dashboard-title-group">
					<h1 class="goal-dashboard-title">${escapeHtml(goal.title)}</h1>
					${goal.branch ? `<span class="goal-dashboard-branch">${escapeHtml(goal.branch)}</span>` : ""}
					<span class="goal-dashboard-state" style="background:${stateColor}">${goal.state}</span>
				</div>
			</div>
			<div class="goal-dashboard-body">
				<div class="goal-dashboard-main">
					<section class="goal-dashboard-section">
						<h2 class="goal-dashboard-section-title">Commit Timeline</h2>
						${renderCommitTimeline(commits, tasks)}
					</section>
				</div>
				<div class="goal-dashboard-sidebar">
					<section class="goal-dashboard-section">
						<h2 class="goal-dashboard-section-title">Task Summary</h2>
						${renderTaskSummary(tasks)}
					</section>
				</div>
			</div>
		</div>
	`;

	// Wire up back button
	container.querySelector(".goal-dashboard-back")?.addEventListener("click", () => {
		setHashRoute("landing");
	});
}

function renderTaskSummary(tasks: TaskInfo[]): string {
	if (tasks.length === 0) {
		return `<div class="task-summary-empty">No tasks yet.</div>`;
	}

	const counts = { backlog: 0, "in-progress": 0, done: 0, failed: 0, stale: 0 };
	for (const t of tasks) {
		if (t.status in counts) counts[t.status as keyof typeof counts]++;
	}

	return `
		<div class="task-summary">
			<div class="task-summary-row"><span class="task-summary-label">Backlog</span><span class="task-summary-count">${counts.backlog}</span></div>
			<div class="task-summary-row"><span class="task-summary-label">In Progress</span><span class="task-summary-count task-summary-count--active">${counts["in-progress"]}</span></div>
			<div class="task-summary-row"><span class="task-summary-label">Done</span><span class="task-summary-count task-summary-count--done">${counts.done}</span></div>
			<div class="task-summary-row"><span class="task-summary-label">Failed</span><span class="task-summary-count task-summary-count--fail">${counts.failed}</span></div>
			<div class="task-summary-row"><span class="task-summary-label">Stale</span><span class="task-summary-count task-summary-count--stale">${counts.stale}</span></div>
		</div>
	`;
}
