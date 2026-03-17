import { html, nothing, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import { state, renderApp, type Goal } from "./state.js";
import { gatewayFetch, deleteGoal } from "./api.js";
import { setHashRoute } from "./routing.js";
import { createAndConnectSession } from "./session-manager.js";
import { showGoalDialog } from "./dialogs.js";
import { statusBobbit } from "./session-colors.js";

// ============================================================================
// TASK & COMMIT TYPES (mirrors server PersistedTask)
// ============================================================================

export type TaskType = "code" | "test" | "review";
export type TaskStatus = "backlog" | "in-progress" | "done" | "failed" | "stale";

export interface Task {
	id: string;
	title: string;
	type: TaskType;
	status: TaskStatus;
	assignee?: string; // session ID
	goalId: string;
	commitSha?: string;
	resultSummary?: string;
	createdAt: number;
	updatedAt: number;
}

export interface CommitInfo {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
}

// ============================================================================
// DASHBOARD STATE
// ============================================================================

let currentGoalId: string | null = null;
let currentGoal: Goal | null = null;
let tasks: Task[] = [];
let commits: CommitInfo[] = [];
let loading = true;
let error = "";

// ============================================================================
// DATA FETCHING
// ============================================================================

export async function loadDashboardData(goalId: string): Promise<void> {
	currentGoalId = goalId;
	loading = true;
	error = "";
	renderApp();

	try {
		const [goalRes, tasksRes, commitsRes] = await Promise.all([
			gatewayFetch(`/api/goals/${goalId}`),
			gatewayFetch(`/api/goals/${goalId}/tasks`),
			gatewayFetch(`/api/goals/${goalId}/commits?limit=20`).catch(() => null),
		]);

		if (!goalRes.ok) throw new Error(`Goal not found (${goalRes.status})`);

		currentGoal = await goalRes.json();

		if (tasksRes.ok) {
			const data = await tasksRes.json();
			tasks = data.tasks || [];
		} else {
			tasks = [];
		}

		if (commitsRes && commitsRes.ok) {
			const data = await commitsRes.json();
			commits = data.commits || [];
		} else {
			commits = [];
		}

		loading = false;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		loading = false;
	}

	renderApp();
}

export function clearDashboardState(): void {
	currentGoalId = null;
	currentGoal = null;
	tasks = [];
	commits = [];
	loading = true;
	error = "";
}

// ============================================================================
// KANBAN BOARD
// ============================================================================

interface KanbanColumn {
	key: TaskStatus;
	label: string;
	dotColor: string;
	tasks: Task[];
}

function getElapsedTime(task: Task): string {
	if (task.status === "done" || task.status === "failed") {
		const elapsed = task.updatedAt - task.createdAt;
		const mins = Math.floor(elapsed / 60_000);
		if (mins < 1) return "<1m";
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		return `${hours}h ${mins % 60}m`;
	}
	const elapsed = Date.now() - task.createdAt;
	const mins = Math.floor(elapsed / 60_000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function typeColor(type: TaskType): string {
	switch (type) {
		case "code": return "var(--type-code)";
		case "test": return "var(--type-test)";
		case "review": return "var(--type-review)";
	}
}

function typeLabel(type: TaskType): string {
	switch (type) {
		case "code": return "Code";
		case "test": return "Test";
		case "review": return "Review";
	}
}

function findAssigneeSession(sessionId: string | undefined) {
	if (!sessionId) return null;
	return state.gatewaySessions.find((s) => s.id === sessionId) || null;
}

function renderTaskCard(task: Task): TemplateResult {
	const isDone = task.status === "done";
	const isFailed = task.status === "failed";
	const isStale = task.status === "stale";
	const assignee = findAssigneeSession(task.assignee);
	const color = typeColor(task.type);

	return html`
		<div
			class="kanban-card"
			style="
				opacity: ${isDone ? "0.75" : "1"};
				--card-type-color: ${color};
			"
		>
			<div class="kanban-card-stripe" style="background: ${color};"></div>
			<div class="kanban-card-body">
				<div class="kanban-card-title">${task.title}</div>
				<div class="kanban-card-meta">
					<span class="kanban-type-badge" style="background: ${color}20; color: ${color};">
						${typeLabel(task.type)}
					</span>
					${isStale ? html`<span class="kanban-stale-badge">Stale</span>` : nothing}
					${assignee ? html`
						<span class="kanban-assignee" title="${assignee.title}" @click=${(e: Event) => {
							e.stopPropagation();
							setHashRoute("session", assignee.id);
						}}>
							${statusBobbit(assignee.status, assignee.isCompacting, assignee.id, false, assignee.isAborting, assignee.role === "team-lead")}
							<span class="kanban-assignee-name">${assignee.title || assignee.id.slice(0, 8)}</span>
						</span>
					` : nothing}
					<span class="kanban-elapsed">${getElapsedTime(task)}</span>
				</div>
				${isFailed && task.resultSummary ? html`
					<div class="kanban-error">${task.resultSummary}</div>
				` : nothing}
			</div>
		</div>
	`;
}

function renderKanbanColumn(col: KanbanColumn): TemplateResult {
	return html`
		<div class="kanban-column">
			<div class="kanban-column-header">
				<span class="kanban-column-dot" style="background: ${col.dotColor};"></span>
				<span class="kanban-column-name">${col.label}</span>
				<span class="kanban-column-count">${col.tasks.length}</span>
			</div>
			<div class="kanban-column-cards">
				${col.tasks.length > 0
					? col.tasks.map(renderTaskCard)
					: html`<div class="kanban-empty">No tasks</div>`
				}
			</div>
		</div>
	`;
}

function renderKanbanBoard(taskList: Task[]): TemplateResult {
	const columns: KanbanColumn[] = [
		{ key: "backlog", label: "Backlog", dotColor: "var(--kanban-backlog)", tasks: [] },
		{ key: "in-progress", label: "In Progress", dotColor: "var(--kanban-in-progress)", tasks: [] },
		{ key: "done", label: "Done", dotColor: "var(--kanban-done)", tasks: [] },
		{ key: "failed", label: "Failed", dotColor: "var(--kanban-failed)", tasks: [] },
	];

	for (const task of taskList) {
		const status = task.status === "stale" ? "done" : task.status;
		const col = columns.find((c) => c.key === status);
		if (col) col.tasks.push(task);
	}

	return html`
		<div class="kanban-board">
			${columns.map(renderKanbanColumn)}
		</div>
	`;
}

// ============================================================================
// COMMIT TIMELINE
// ============================================================================

type BadgeStatus = "pass" | "fail" | "stale" | "pending";

interface CommitBadges {
	tests?: BadgeStatus;
	review?: BadgeStatus;
}

function deriveBadges(commitList: CommitInfo[], taskList: Task[]): Map<string, CommitBadges> {
	const badges = new Map<string, CommitBadges>();
	for (const c of commitList) {
		badges.set(c.sha, {});
	}

	const testTasks = taskList.filter(t => t.type === "test" && t.commitSha);
	const reviewTasks = taskList.filter(t => t.type === "review" && t.commitSha);

	for (const task of testTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.status === "done") b.tests = "pass";
		else if (task.status === "failed") b.tests = "fail";
		else if (task.status === "stale") b.tests = "stale";
		else if (task.status === "in-progress") b.tests = "pending";
	}

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
	const diffMs = Date.now() - new Date(timestamp).getTime();
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const badgeIcons: Record<BadgeStatus, string> = {
	pass: "\u2713",
	fail: "\u2717",
	stale: "\u27F3",
	pending: "\u23F3",
};

function renderCommitBadge(label: string, status: BadgeStatus): TemplateResult {
	return html`<span class="commit-badge commit-badge--${status}" title="${label}: ${status}">${badgeIcons[status]} ${label}</span>`;
}

function renderCommitTimeline(commitList: CommitInfo[], taskList: Task[]): TemplateResult {
	if (commitList.length === 0) {
		return html`<div class="commit-timeline-empty">No commits found on this branch.</div>`;
	}

	const badges = deriveBadges(commitList, taskList);

	return html`
		<div class="commit-timeline">
			${commitList.map((commit, index) => {
				const isHead = index === 0;
				const b = badges.get(commit.sha) || {};
				return html`
					<div class="commit-item" data-sha="${commit.sha}">
						<div class="${isHead ? "commit-dot commit-dot--head" : "commit-dot"}"></div>
						<div class="commit-content">
							<div class="commit-header">
								<code class="commit-sha">${commit.shortSha}</code>
								${b.tests ? renderCommitBadge("Tests", b.tests) : nothing}
								${b.review ? renderCommitBadge("Review", b.review) : nothing}
								<span class="commit-time">${formatRelativeTime(commit.timestamp)}</span>
							</div>
							<div class="commit-message">${commit.message}</div>
							<div class="commit-author">${commit.author}</div>
						</div>
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// DASHBOARD LAYOUT
// ============================================================================

function renderNavBar(goal: Goal): TemplateResult {
	return html`
		<div class="dashboard-nav">
			<div class="dashboard-nav-left">
				<button class="dashboard-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<div class="dashboard-title-group">
					<h1 class="dashboard-title">${goal.title}</h1>
					${goal.branch ? html`<span class="dashboard-branch">${goal.branch}</span>` : nothing}
				</div>
			</div>
			<div class="dashboard-nav-right">
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => showGoalDialog(goal),
					children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "sm")} Edit</span>`,
				})}
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => deleteGoal(goal.id),
					children: html`<span class="inline-flex items-center gap-1 text-destructive">${icon(Trash2, "sm")} Delete</span>`,
				})}
				${Button({
					variant: "default",
					size: "sm",
					onClick: () => createAndConnectSession(goal.id),
					children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} New Session</span>`,
				})}
			</div>
		</div>
	`;
}

function renderSummaryHeader(goal: Goal, taskList: Task[]): TemplateResult {
	const total = taskList.length;
	const done = taskList.filter((t) => t.status === "done").length;
	const inProgress = taskList.filter((t) => t.status === "in-progress").length;
	const failed = taskList.filter((t) => t.status === "failed").length;
	const activeAgents = state.gatewaySessions.filter(
		(s) => s.goalId === goal.id && !s.delegateOf && (s.status === "streaming" || s.status === "busy"),
	).length;

	return html`
		<div class="dashboard-summary">
			<div class="dashboard-stat">
				<span class="dashboard-stat-value">${done}/${total}</span>
				<span class="dashboard-stat-label">Tasks done</span>
			</div>
			<div class="dashboard-stat">
				<span class="dashboard-stat-value">${inProgress}</span>
				<span class="dashboard-stat-label">In progress</span>
			</div>
			<div class="dashboard-stat">
				<span class="dashboard-stat-value">${failed}</span>
				<span class="dashboard-stat-label">Failed</span>
			</div>
			<div class="dashboard-stat">
				<span class="dashboard-stat-value">${activeAgents}</span>
				<span class="dashboard-stat-label">Active agents</span>
			</div>
		</div>
	`;
}

export function renderGoalDashboard(): TemplateResult {
	if (loading) {
		return html`
			<div class="dashboard-container">
				<div class="dashboard-loading">
					<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
					</svg>
					<span>Loading dashboard\u2026</span>
				</div>
			</div>
		`;
	}

	if (error || !currentGoal) {
		return html`
			<div class="dashboard-container">
				<div class="dashboard-error">
					<p>${error || "Goal not found"}</p>
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => setHashRoute("landing"),
						children: "Back to sessions",
					})}
				</div>
			</div>
		`;
	}

	return html`
		<div class="dashboard-container">
			${renderNavBar(currentGoal)}
			${renderSummaryHeader(currentGoal, tasks)}
			<div class="dashboard-section">
				<h2 class="dashboard-section-title">Tasks</h2>
				${renderKanbanBoard(tasks)}
			</div>
			${commits.length > 0 ? html`
				<div class="dashboard-section">
					<h2 class="dashboard-section-title">Commit Timeline</h2>
					${renderCommitTimeline(commits, tasks)}
				</div>
			` : nothing}
		</div>
	`;
}
