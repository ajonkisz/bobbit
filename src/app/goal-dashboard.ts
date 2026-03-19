import { html, nothing, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { ArrowLeft, Pencil, Play, Plus, Square, Trash2 } from "lucide";
import { state, renderApp, type Goal } from "./state.js";
import { gatewayFetch, deleteGoal, startTeam, teardownTeam, getTeamState, fetchGoalArtifacts, type GoalArtifact, type ArtifactType } from "./api.js";
import { setHashRoute } from "./routing.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { showGoalDialog } from "./dialogs.js";
import { statusBobbit } from "./session-colors.js";

// ============================================================================
// TASK & COMMIT TYPES (mirrors server PersistedTask)
// ============================================================================

export type TaskType = "code" | "test" | "review";
export type TaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";

export interface Task {
	id: string;
	title: string;
	type: TaskType;
	state: TaskState;
	assignedSessionId?: string;
	goalId: string;
	commitSha?: string;
	resultSummary?: string;
	spec?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	dependsOn?: string[];
}

export interface CommitInfo {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
}

// ============================================================================
// REPORT TYPES
// ============================================================================

export interface ReportInfo {
	sessionId: string;
	workflowId: string;
	workflowName: string;
	status: "running" | "completed" | "skipped" | "cancelled";
	startedAt: number;
	completedAt?: number;
	artifactCount: number;
	/** Derived from workflowId */
	type: "code-review" | "test-suite" | "other";
}

// ============================================================================
// DASHBOARD STATE
// ============================================================================

let currentGoalId: string | null = null;
let currentGoal: Goal | null = null;
let tasks: Task[] = [];
let commits: CommitInfo[] = [];
let reports: ReportInfo[] = [];
let artifacts: GoalArtifact[] = [];
let expandedArtifactIds: Set<string> = new Set();
let artifactPollTimer: ReturnType<typeof setInterval> | null = null;
let teamActive = false;
let teamStarting = false;
let teamStopping = false;
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

	// Start polling (runs independently of the main data load)
	startAgentPolling(goalId);
	startTaskPolling(goalId);

	try {
		const [goalRes, tasksRes, commitsRes, fetchedArtifacts] = await Promise.all([
			gatewayFetch(`/api/goals/${goalId}`),
			gatewayFetch(`/api/goals/${goalId}/tasks`),
			gatewayFetch(`/api/goals/${goalId}/commits?limit=20`).catch(() => null),
			fetchGoalArtifacts(goalId),
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

		artifacts = fetchedArtifacts;

		// Fetch workflow reports for all sessions belonging to this goal
		reports = await fetchGoalReports(goalId);

		// Check if a team is active
		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;

		// Start artifact polling
		startArtifactPolling(goalId);

		loading = false;
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		loading = false;
	}

	renderApp();
}

async function fetchGoalReports(goalId: string): Promise<ReportInfo[]> {
	const goalSessions = state.gatewaySessions.filter((s) => s.goalId === goalId);
	const results: ReportInfo[] = [];

	await Promise.all(
		goalSessions.map(async (session) => {
			try {
				const res = await gatewayFetch(`/api/sessions/${session.id}/workflow`);
				if (!res.ok) return;
				const ws = await res.json() as {
					workflowId: string;
					status: string;
					startedAt: number;
					completedAt?: number;
					artifacts?: unknown[];
					context?: Record<string, string>;
				};

				let type: ReportInfo["type"] = "other";
				if (ws.workflowId.includes("code-review")) type = "code-review";
				else if (ws.workflowId.includes("test")) type = "test-suite";

				// Derive a friendly name from the workflow ID
				const workflowName = ws.workflowId
					.split("-")
					.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
					.join(" ");

				results.push({
					sessionId: session.id,
					workflowId: ws.workflowId,
					workflowName,
					status: ws.status as ReportInfo["status"],
					startedAt: ws.startedAt,
					completedAt: ws.completedAt,
					artifactCount: ws.artifacts?.length ?? 0,
					type,
				});
			} catch {
				// Session has no workflow — skip
			}
		}),
	);

	// Sort by most recent first
	results.sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
	return results;
}

export function clearDashboardState(): void {
	currentGoalId = null;
	currentGoal = null;
	tasks = [];
	commits = [];
	reports = [];
	artifacts = [];
	expandedArtifactIds = new Set();
	teamActive = false;
	teamStarting = false;
	teamStopping = false;
	loading = true;
	error = "";
	stopAgentPolling();
	stopTaskPolling();
	stopArtifactPolling();
}

// ============================================================================
// KANBAN BOARD
// ============================================================================

interface KanbanColumn {
	key: string;
	label: string;
	dotColor: string;
	tasks: Task[];
}

function getElapsedTime(task: Task): string {
	if (task.state === "complete" || task.state === "skipped") {
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
	const isDone = task.state === "complete";
	const isFailed = task.state === "skipped";
	const headSha = commits?.[0]?.sha;
	const isStale = task.state === "complete" && (task.type === "test" || task.type === "review" || task.type === "code") && task.commitSha != null && headSha != null && task.commitSha !== headSha;
	const assignee = findAssigneeSession(task.assignedSessionId);
	const color = typeColor(task.type);

	return html`
		<div
			class="kanban-card ${isStale ? "kanban-card--stale" : ""}"
			style="
				opacity: ${isDone || isStale ? "0.65" : "1"};
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
							setHashRoute("session", assignee.id, true);
						}}>
							${statusBobbit(assignee.status, assignee.isCompacting, assignee.id, false, assignee.isAborting, assignee.role === "team-lead", assignee.role === "coder", assignee.accessory)}
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
		{ key: "todo", label: "Backlog", dotColor: "var(--kanban-backlog)", tasks: [] },
		{ key: "in-progress", label: "In Progress", dotColor: "var(--kanban-in-progress)", tasks: [] },
		{ key: "complete", label: "Done", dotColor: "var(--kanban-done)", tasks: [] },
		// Stale tasks stay in Done but get a visual stale badge
		{ key: "skipped", label: "Failed", dotColor: "var(--kanban-failed)", tasks: [] },
	];

	for (const task of taskList) {
		const mappedKey = task.state === "blocked" ? "todo" : task.state;
		const col = columns.find((c) => c.key === mappedKey);
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
		if (task.state === "complete") b.tests = "pass";
		else if (task.state === "skipped") b.tests = "fail";
		else if (false) b.tests = "stale";
		else if (task.state === "in-progress") b.tests = "pending";
	}

	for (const task of reviewTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.review = "pass";
		else if (task.state === "skipped") b.review = "fail";
		else if (false) b.review = "stale";
		else if (task.state === "in-progress") b.review = "pending";
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
// AGENT ACTIVITY PANEL
// ============================================================================

export interface TeamAgent {
	sessionId: string;
	role: string;
	status: string; // "starting" | "idle" | "streaming" | "terminated"
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
}

let agents: TeamAgent[] = [];
let agentPollTimer: ReturnType<typeof setInterval> | null = null;
let taskPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchAgents(goalId: string): Promise<TeamAgent[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/agents`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.agents ?? [];
	} catch {
		return [];
	}
}

function startTaskPolling(goalId: string): void {
	stopTaskPolling();
	taskPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/tasks`);
			if (res.ok) {
				const data = await res.json();
				const newTasks: Task[] = data.tasks || [];
				// Only re-render if data actually changed
				if (JSON.stringify(newTasks) !== JSON.stringify(tasks)) {
					tasks = newTasks;
					renderApp();
				}
			}
		} catch { /* ignore poll errors */ }
	}, 10_000);
}

function stopTaskPolling(): void {
	if (taskPollTimer) {
		clearInterval(taskPollTimer);
		taskPollTimer = null;
	}
}

function startAgentPolling(goalId: string): void {
	stopAgentPolling();
	// Initial fetch
	fetchAgents(goalId).then((a) => {
		agents = a;
		renderApp();
	});
	// Poll every 5 seconds
	agentPollTimer = setInterval(async () => {
		agents = await fetchAgents(goalId);
		// Also refresh team active state
		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;
		renderApp();
	}, 5000);
}

function stopAgentPolling(): void {
	if (agentPollTimer) {
		clearInterval(agentPollTimer);
		agentPollTimer = null;
	}
	agents = [];
}

function agentStatusLabel(status: string): "working" | "idle" | "blocked" {
	if (status === "streaming") return "working";
	if (status === "idle") return "idle";
	return "blocked";
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
	coder: { bg: "rgba(59, 130, 246, 0.15)", text: "#3b82f6" },
	tester: { bg: "rgba(34, 197, 94, 0.15)", text: "#22c55e" },
	reviewer: { bg: "rgba(245, 158, 11, 0.15)", text: "#f59e0b" },
	lead: { bg: "rgba(168, 85, 247, 0.15)", text: "#a855f7" },
	"team-lead": { bg: "rgba(168, 85, 247, 0.15)", text: "#a855f7" },
};

function getRoleColor(role: string): { bg: string; text: string } {
	return ROLE_COLORS[role] ?? ROLE_COLORS["coder"];
}

function getRoleLabel(role: string): string {
	if (role === "team-lead") return "LEAD";
	return role.toUpperCase();
}

const AVATAR_COLORS = [
	"#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ef4444",
	"#06b6d4", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6",
];

function getAvatarColor(sessionId: string): string {
	let hash = 0;
	for (let i = 0; i < sessionId.length; i++) {
		hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
	}
	return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(role: string): string {
	if (role === "team-lead") return "TL";
	return role.charAt(0).toUpperCase();
}

function formatAgentName(agent: TeamAgent): string {
	const session = state.gatewaySessions.find((s) => s.id === agent.sessionId);
	if (session?.title) return session.title;
	if (agent.role === "team-lead") return "Team Lead";
	return agent.role.charAt(0).toUpperCase() + agent.role.slice(1);
}

export function renderAgentPanel(agentList: TeamAgent[]): TemplateResult {
	if (agentList.length === 0) {
		return html`
			<div class="agent-panel">
				<div class="agent-panel-header">Agents</div>
				<div class="agent-panel-empty">No active agents</div>
			</div>
		`;
	}

	return html`
		<div class="agent-panel">
			<div class="agent-panel-header">Agents <span class="agent-count">${agentList.length}</span></div>
			${agentList.map((agent) => {
				const statusLabel = agentStatusLabel(agent.status);
				const roleColor = getRoleColor(agent.role);
				const avatarColor = getAvatarColor(agent.sessionId);
				const initials = getInitials(agent.role);

				return html`
					<div class="agent-row" @click=${() => connectToSession(agent.sessionId, true)} title="Open session">
						<div class="agent-avatar" style="background: ${avatarColor}">
							${initials}
						</div>
						<div class="agent-info">
							<div class="agent-name-row">
								<span class="agent-name">${formatAgentName(agent)}</span>
								<span class="role-badge" style="background: ${roleColor.bg}; color: ${roleColor.text}">
									${getRoleLabel(agent.role)}
								</span>
							</div>
							<div class="agent-task">${agent.task || "No active task"}</div>
						</div>
						<div class="agent-status-dot agent-status-${statusLabel}" title="${statusLabel}"></div>
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// ARTIFACT POLLING
// ============================================================================

function startArtifactPolling(goalId: string): void {
	stopArtifactPolling();
	artifactPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const newArtifacts = await fetchGoalArtifacts(goalId);
			if (JSON.stringify(newArtifacts) !== JSON.stringify(artifacts)) {
				artifacts = newArtifacts;
				renderApp();
			}
		} catch { /* ignore poll errors */ }
	}, 10_000);
}

function stopArtifactPolling(): void {
	if (artifactPollTimer) {
		clearInterval(artifactPollTimer);
		artifactPollTimer = null;
	}
}

// ============================================================================
// PHASE INDICATOR
// ============================================================================

type GoalPhase = "planning" | "design" | "implementation" | "review" | "complete";

interface PhaseInfo {
	phase: GoalPhase;
	label: string;
	description: string;
}

const PHASES: PhaseInfo[] = [
	{ phase: "planning", label: "Planning", description: "No artifacts produced yet" },
	{ phase: "design", label: "Design", description: "Design document exists" },
	{ phase: "implementation", label: "Implementation", description: "Design + test plan ready" },
	{ phase: "review", label: "Review", description: "Review findings produced" },
	{ phase: "complete", label: "Complete", description: "All required artifacts exist" },
];

function derivePhase(artifactList: GoalArtifact[]): GoalPhase {
	const types = new Set(artifactList.map((a) => a.type));
	const hasDesign = types.has("design-doc");
	const hasTestPlan = types.has("test-plan");
	const hasReview = types.has("review-findings");

	if (hasDesign && hasTestPlan && hasReview) return "complete";
	if (hasReview) return "review";
	if (hasDesign && hasTestPlan) return "implementation";
	if (hasDesign) return "design";
	return "planning";
}

const PHASE_COLORS: Record<GoalPhase, string> = {
	planning: "#6b7280",
	design: "#8b5cf6",
	implementation: "#3b82f6",
	review: "#f59e0b",
	complete: "#22c55e",
};

function renderPhaseIndicator(artifactList: GoalArtifact[]): TemplateResult {
	const currentPhase = derivePhase(artifactList);
	const currentIdx = PHASES.findIndex((p) => p.phase === currentPhase);

	return html`
		<div class="phase-indicator">
			<div class="phase-indicator-header">Phase</div>
			<div class="phase-track">
				${PHASES.map((p, i) => {
					const isActive = i === currentIdx;
					const isPast = i < currentIdx;
					const color = isPast || isActive ? PHASE_COLORS[p.phase] : "hsl(var(--border))";
					return html`
						<div class="phase-step ${isActive ? "phase-step--active" : ""} ${isPast ? "phase-step--past" : ""}">
							<div class="phase-dot" style="background: ${color}; ${isActive ? `box-shadow: 0 0 0 3px ${color}40;` : ""}"></div>
							${i < PHASES.length - 1 ? html`<div class="phase-line" style="background: ${isPast ? PHASE_COLORS[PHASES[i + 1].phase] : "hsl(var(--border))"};"></div>` : nothing}
							<div class="phase-label" style="color: ${isActive ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))"}">${p.label}</div>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// REQUIRED ARTIFACTS PANEL
// ============================================================================

interface ArtifactRequirementStatus {
	type: ArtifactType;
	label: string;
	required: boolean;
	artifact: GoalArtifact | null;
}

const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
	"design-doc": "Design Document",
	"test-plan": "Test Plan",
	"review-findings": "Review Findings",
	"gap-analysis": "Gap Analysis",
	"security-findings": "Security Findings",
	"custom": "Custom",
};

const ARTIFACT_TYPE_ICONS: Record<ArtifactType, string> = {
	"design-doc": "\uD83D\uDCD0",       // 📐
	"test-plan": "\uD83E\uDDEA",         // 🧪
	"review-findings": "\uD83D\uDD0D",   // 🔍
	"gap-analysis": "\uD83D\uDCCA",      // 📊
	"security-findings": "\uD83D\uDD12", // 🔒
	"custom": "\uD83D\uDCCB",            // 📋
};

const REQUIRED_ARTIFACT_TYPES: ArtifactType[] = ["design-doc", "test-plan", "review-findings"];

function getArtifactStatuses(artifactList: GoalArtifact[]): ArtifactRequirementStatus[] {
	const byType = new Map<ArtifactType, GoalArtifact>();
	for (const a of artifactList) {
		const existing = byType.get(a.type);
		// Keep the latest version
		if (!existing || a.updatedAt > existing.updatedAt) {
			byType.set(a.type, a);
		}
	}

	const statuses: ArtifactRequirementStatus[] = [];

	// Required artifacts first
	for (const type of REQUIRED_ARTIFACT_TYPES) {
		statuses.push({
			type,
			label: ARTIFACT_TYPE_LABELS[type],
			required: true,
			artifact: byType.get(type) || null,
		});
	}

	// Additional artifacts that exist but aren't in the required list
	for (const a of artifactList) {
		if (!REQUIRED_ARTIFACT_TYPES.includes(a.type) && !statuses.some((s) => s.type === a.type)) {
			statuses.push({
				type: a.type,
				label: ARTIFACT_TYPE_LABELS[a.type] || a.type,
				required: false,
				artifact: byType.get(a.type) || null,
			});
		}
	}

	return statuses;
}

function toggleArtifactExpand(artifactId: string): void {
	if (expandedArtifactIds.has(artifactId)) {
		expandedArtifactIds.delete(artifactId);
	} else {
		expandedArtifactIds.add(artifactId);
	}
	renderApp();
}

function formatArtifactTime(timestamp: number): string {
	const diffMs = Date.now() - timestamp;
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function renderArtifactStatus(status: ArtifactRequirementStatus): TemplateResult {
	const { type, label, required, artifact } = status;
	const iconStr = ARTIFACT_TYPE_ICONS[type] || "\uD83D\uDCCB";
	const exists = artifact != null;
	const isExpanded = artifact ? expandedArtifactIds.has(artifact.id) : false;

	return html`
		<div class="artifact-row ${exists ? "artifact-row--exists" : "artifact-row--missing"}"
			@click=${() => artifact && toggleArtifactExpand(artifact.id)}>
			<div class="artifact-icon">${iconStr}</div>
			<div class="artifact-info">
				<div class="artifact-name">
					${label}
					${required ? html`<span class="artifact-required-badge">Required</span>` : nothing}
				</div>
				<div class="artifact-meta">
					${exists
						? html`<span class="artifact-status artifact-status--exists">v${artifact!.version}</span>
							<span class="artifact-time">${formatArtifactTime(artifact!.updatedAt)}</span>`
						: html`<span class="artifact-status artifact-status--missing">Missing</span>`
					}
				</div>
			</div>
			${exists ? html`
				<div class="artifact-expand-icon">${isExpanded ? "\u25B2" : "\u25BC"}</div>
			` : nothing}
		</div>
		${isExpanded && artifact ? html`
			<div class="artifact-content-panel">
				<div class="artifact-content-header">
					<span>${artifact.name}</span>
					${artifact.skillId ? html`<span class="artifact-skill-badge">Skill: ${artifact.skillId}</span>` : nothing}
				</div>
				<pre class="artifact-content-body">${artifact.content}</pre>
			</div>
		` : nothing}
	`;
}

function renderArtifactsPanel(artifactList: GoalArtifact[]): TemplateResult {
	const statuses = getArtifactStatuses(artifactList);

	return html`
		<div class="artifacts-panel">
			<div class="artifacts-panel-header">Artifacts</div>
			${statuses.length > 0
				? statuses.map(renderArtifactStatus)
				: html`<div class="artifacts-panel-empty">No artifacts yet</div>`
			}
		</div>
	`;
}

// ============================================================================
// ARTIFACT TIMELINE
// ============================================================================

function renderArtifactTimeline(artifactList: GoalArtifact[]): TemplateResult {
	if (artifactList.length === 0) return html``;

	// Sort by updatedAt desc (most recent first)
	const sorted = [...artifactList].sort((a, b) => b.updatedAt - a.updatedAt);

	return html`
		<div class="dashboard-section">
			<h2 class="dashboard-section-title">Artifact Timeline</h2>
			<div class="artifact-timeline">
				${sorted.map((artifact, index) => {
					const iconStr = ARTIFACT_TYPE_ICONS[artifact.type] || "\uD83D\uDCCB";
					const isFirst = index === 0;
					const isExpanded = expandedArtifactIds.has(artifact.id);
					const session = state.gatewaySessions.find((s) => s.id === artifact.producedBy);
					const producerName = session?.title || artifact.producedBy.slice(0, 8);

					return html`
						<div class="artifact-timeline-item" @click=${() => toggleArtifactExpand(artifact.id)}>
							<div class="${isFirst ? "artifact-timeline-dot artifact-timeline-dot--latest" : "artifact-timeline-dot"}"></div>
							<div class="artifact-timeline-content">
								<div class="artifact-timeline-header">
									<span class="artifact-timeline-icon">${iconStr}</span>
									<span class="artifact-timeline-name">${ARTIFACT_TYPE_LABELS[artifact.type] || artifact.name}</span>
									<span class="artifact-timeline-version">v${artifact.version}</span>
									<span class="artifact-timeline-time">${formatArtifactTime(artifact.updatedAt)}</span>
								</div>
								<div class="artifact-timeline-meta">
									${artifact.version > 1 ? html`<span>Revised</span><span>\u00B7</span>` : html`<span>Created</span><span>\u00B7</span>`}
									<span>by ${producerName}</span>
									${artifact.skillId ? html`<span>\u00B7</span><span>via ${artifact.skillId}</span>` : nothing}
								</div>
								${isExpanded ? html`
									<pre class="artifact-content-body artifact-timeline-body">${artifact.content}</pre>
								` : nothing}
							</div>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// REPORTS PANEL
// ============================================================================

function reportTypeIcon(type: ReportInfo["type"]): string {
	switch (type) {
		case "code-review": return "\uD83D\uDD0D"; // 🔍
		case "test-suite": return "\uD83E\uDDEA"; // 🧪
		default: return "\uD83D\uDCCB"; // 📋
	}
}

function reportTypeColor(type: ReportInfo["type"], failed: boolean): string {
	if (failed) return "#ef4444";
	switch (type) {
		case "code-review": return "#f59e0b";
		case "test-suite": return "#22c55e";
		default: return "#6b7280";
	}
}

function reportStatusLabel(status: ReportInfo["status"]): string {
	switch (status) {
		case "completed": return "Completed";
		case "skipped": return "Failed";
		case "running": return "Running";
		case "cancelled": return "Cancelled";
	}
}

function formatReportTime(timestamp: number): string {
	const diffMs = Date.now() - timestamp;
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function openReport(sessionId: string): void {
	const base = window.location.origin;
	const token = new URLSearchParams(window.location.search).get("token") || "";
	const url = `${base}/api/sessions/${sessionId}/workflow/report${token ? `?token=${encodeURIComponent(token)}` : ""}`;
	window.open(url, "_blank");
}

function renderReportCard(report: ReportInfo): TemplateResult {
	const isFailed = report.status === "skipped" || report.status === "cancelled";
	const color = reportTypeColor(report.type, isFailed);
	const completedTime = report.completedAt
		? formatReportTime(report.completedAt)
		: reportStatusLabel(report.status);

	return html`
		<div
			class="report-card ${isFailed ? "report-card--failed" : ""}"
			@click=${() => openReport(report.sessionId)}
			title="Open ${report.workflowName} report"
		>
			<div class="report-icon" style="background: ${color}20; color: ${color};">
				${reportTypeIcon(report.type)}
			</div>
			<div class="report-info">
				<div class="report-title">${report.workflowName}</div>
				<div class="report-meta">
					<span>${completedTime}</span>
					${report.artifactCount > 0 ? html`<span>\u00B7 ${report.artifactCount} artifact${report.artifactCount !== 1 ? "s" : ""}</span>` : nothing}
				</div>
			</div>
		</div>
	`;
}

function renderReportsPanel(reportList: ReportInfo[]): TemplateResult {
	return html`
		<div class="reports-panel">
			<div class="reports-panel-header">Reports</div>
			${reportList.length > 0
				? reportList.map(renderReportCard)
				: html`<div class="reports-panel-empty">No reports yet</div>`
			}
		</div>
	`;
}

// ============================================================================
// DASHBOARD LAYOUT
// ============================================================================

async function handleStartTeam(goalId: string): Promise<void> {
	teamStarting = true;
	renderApp();
	const sessionId = await startTeam(goalId);
	teamStarting = false;
	if (sessionId) {
		teamActive = true;
		renderApp();
		connectToSession(sessionId, false);
	} else {
		renderApp();
	}
}

async function handleEndTeam(goalId: string): Promise<void> {
	teamStopping = true;
	renderApp();
	const ok = await teardownTeam(goalId);
	teamStopping = false;
	if (ok) {
		teamActive = false;
		agents = [];
	}
	renderApp();
}

function renderNavBar(goal: Goal): TemplateResult {
	const isTeamGoal = !!goal.team;

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
	const done = taskList.filter((t) => t.state === "complete").length;
	const inProgress = taskList.filter((t) => t.state === "in-progress").length;
	const failed = taskList.filter((t) => t.state === "skipped").length;
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
			${renderPhaseIndicator(artifacts)}
			<div class="dashboard-body">
				<div class="dashboard-main-content">
					<div class="dashboard-section">
						<h2 class="dashboard-section-title">Tasks</h2>
						${renderKanbanBoard(tasks)}
					</div>
					${renderArtifactTimeline(artifacts)}
					${commits.length > 0 ? html`
						<div class="dashboard-section">
							<h2 class="dashboard-section-title">Commit Timeline</h2>
							${renderCommitTimeline(commits, tasks)}
						</div>
					` : nothing}
				</div>
				<div class="dashboard-right-panel">
					${renderAgentPanel(agents)}
					${renderArtifactsPanel(artifacts)}
					${renderReportsPanel(reports)}
				</div>
			</div>
		</div>
	`;
}
