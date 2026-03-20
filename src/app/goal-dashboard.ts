import { html, nothing, type TemplateResult } from "lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { state, renderApp, type Goal } from "./state.js";
import { gatewayFetch, deleteGoal, startTeam, teardownTeam, getTeamState, fetchGoalArtifacts, fetchRoles, type GoalArtifact, type ArtifactType } from "./api.js";
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
// DASHBOARD STATE
// ============================================================================

let currentGoalId: string | null = null;
let currentGoal: Goal | null = null;
let tasks: Task[] = [];
let commits: CommitInfo[] = [];
let artifacts: GoalArtifact[] = [];
let expandedArtifactIds: Set<string> = new Set();
let artifactPollTimer: ReturnType<typeof setInterval> | null = null;
let teamActive = false;
let teamStarting = false;
let teamStopping = false;
let loading = true;
let error = "";

/** Git merge status for goal branch */
interface GoalGitStatus {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	clean: boolean;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
}
let gitStatus: GoalGitStatus | null = null;

/** Aggregated cost for goal */
interface GoalCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
}
let goalCost: GoalCost | null = null;
let costPollTimer: ReturnType<typeof setInterval> | null = null;
let gitStatusPollTimer: ReturnType<typeof setInterval> | null = null;

/** Current dashboard tab */
let dashboardTab: "tasks" | "agents" | "commits" | "artifacts" = "tasks";

/** Role picker dropdown state */
let roleDropdownOpen = false;

// ============================================================================
// DATA FETCHING
// ============================================================================

export async function loadDashboardData(goalId: string): Promise<void> {
	currentGoalId = goalId;
	loading = true;
	error = "";
	renderApp();

	startAgentPolling(goalId);
	startTaskPolling(goalId);

	try {
		const [goalRes, tasksRes, commitsRes, fetchedArtifacts, gitStatusRes, costRes] = await Promise.all([
			gatewayFetch(`/api/goals/${goalId}`),
			gatewayFetch(`/api/goals/${goalId}/tasks`),
			gatewayFetch(`/api/goals/${goalId}/commits?limit=20`).catch(() => null),
			fetchGoalArtifacts(goalId),
			gatewayFetch(`/api/goals/${goalId}/git-status`).catch(() => null),
			gatewayFetch(`/api/goals/${goalId}/cost`).catch(() => null),
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

		if (gitStatusRes && gitStatusRes.ok) {
			gitStatus = await gitStatusRes.json();
		}

		if (costRes && costRes.ok) {
			goalCost = await costRes.json();
		}

		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;

		startArtifactPolling(goalId);
		startCostPolling(goalId);
		startGitStatusPolling(goalId);

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
	artifacts = [];
	expandedArtifactIds = new Set();
	teamActive = false;
	teamStarting = false;
	teamStopping = false;
	loading = true;
	error = "";
	dashboardTab = "tasks";
	roleDropdownOpen = false;
	gitStatus = null;
	goalCost = null;
	stopAgentPolling();
	stopTaskPolling();
	stopArtifactPolling();
	stopCostPolling();
	stopGitStatusPolling();
}

// ============================================================================
// AGENT TYPES & POLLING
// ============================================================================

export interface TeamAgent {
	sessionId: string;
	role: string;
	status: string;
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
				if (JSON.stringify(newTasks) !== JSON.stringify(tasks)) {
					tasks = newTasks;
					renderApp();
				}
			}
		} catch { /* ignore */ }
	}, 10_000);
}

function stopTaskPolling(): void {
	if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
}

function startAgentPolling(goalId: string): void {
	stopAgentPolling();
	fetchAgents(goalId).then((a) => { agents = a; renderApp(); });
	agentPollTimer = setInterval(async () => {
		agents = await fetchAgents(goalId);
		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;
		renderApp();
	}, 5000);
}

function stopAgentPolling(): void {
	if (agentPollTimer) { clearInterval(agentPollTimer); agentPollTimer = null; }
	agents = [];
}

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
		} catch { /* ignore */ }
	}, 10_000);
}

function stopArtifactPolling(): void {
	if (artifactPollTimer) { clearInterval(artifactPollTimer); artifactPollTimer = null; }
}

function startCostPolling(goalId: string): void {
	stopCostPolling();
	costPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/cost`);
			if (res.ok) {
				const newCost: GoalCost = await res.json();
				if (newCost.totalCost !== goalCost?.totalCost) {
					goalCost = newCost;
					renderApp();
				}
			}
		} catch { /* ignore */ }
	}, 15_000);
}

function stopCostPolling(): void {
	if (costPollTimer) { clearInterval(costPollTimer); costPollTimer = null; }
}

function startGitStatusPolling(goalId: string): void {
	stopGitStatusPolling();
	gitStatusPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/git-status`);
			if (res.ok) {
				const newStatus: GoalGitStatus = await res.json();
				if (JSON.stringify(newStatus) !== JSON.stringify(gitStatus)) {
					gitStatus = newStatus;
					renderApp();
				}
			}
		} catch { /* ignore */ }
	}, 30_000);
}

function stopGitStatusPolling(): void {
	if (gitStatusPollTimer) { clearInterval(gitStatusPollTimer); gitStatusPollTimer = null; }
}

// ============================================================================
// HELPERS
// ============================================================================

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

function formatRelativeTime(timestamp: string | number): string {
	const diffMs = Date.now() - new Date(timestamp).getTime();
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
	coder: { bg: "oklch(0.62 0.15 250 / 0.15)", text: "oklch(0.72 0.15 250)" },
	tester: { bg: "oklch(0.65 0.15 145 / 0.15)", text: "oklch(0.72 0.15 145)" },
	reviewer: { bg: "oklch(0.70 0.14 75 / 0.15)", text: "oklch(0.78 0.14 75)" },
	lead: { bg: "oklch(0.55 0.15 290 / 0.15)", text: "oklch(0.72 0.15 290)" },
	"team-lead": { bg: "oklch(0.55 0.15 290 / 0.15)", text: "oklch(0.72 0.15 290)" },
};

function getRoleColor(role: string): { bg: string; text: string } {
	return ROLE_COLORS[role] ?? ROLE_COLORS["coder"];
}

function getRoleLabel(role: string): string {
	if (role === "team-lead") return "LEAD";
	return role.toUpperCase();
}

function formatAgentName(agent: TeamAgent): string {
	const session = state.gatewaySessions.find((s) => s.id === agent.sessionId);
	if (session?.title) return session.title;
	if (agent.role === "team-lead") return "Team Lead";
	return agent.role.charAt(0).toUpperCase() + agent.role.slice(1);
}

// ============================================================================
// PHASE DERIVATION
// ============================================================================

type GoalPhase = "planning" | "design" | "implementation" | "review" | "complete";

const PHASES: { phase: GoalPhase; label: string }[] = [
	{ phase: "planning", label: "Planning" },
	{ phase: "design", label: "Design" },
	{ phase: "implementation", label: "Implementation" },
	{ phase: "review", label: "Review" },
	{ phase: "complete", label: "Complete" },
];

function derivePhase(artifactList: GoalArtifact[], taskList: Task[]): GoalPhase {
	const types = new Set(artifactList.map((a) => a.type));
	const hasDesign = types.has("design-doc");
	const hasTestPlan = types.has("test-plan");
	const hasReview = types.has("review-findings");
	const hasSummary = types.has("summary-report");

	if (hasDesign && hasTestPlan && hasReview && hasSummary) return "complete";

	const allTasksDone = taskList.length > 0 && taskList.every(t => t.state === "complete" || t.state === "skipped");
	if (hasReview || (allTasksDone && taskList.length > 0)) return "review";
	if (hasDesign && hasTestPlan) return "implementation";
	if (hasDesign) return "design";
	return "planning";
}

// ============================================================================
// ARTIFACT HELPERS
// ============================================================================

const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
	"design-doc": "Design Document",
	"test-plan": "Test Plan",
	"review-findings": "Review Findings",
	"gap-analysis": "Gap Analysis",
	"security-findings": "Security Findings",
	"summary-report": "Summary Report",
	"custom": "Custom",
};

const ARTIFACT_TYPE_ICONS: Record<ArtifactType, string> = {
	"design-doc": "\uD83D\uDCD0",
	"test-plan": "\uD83E\uDDEA",
	"review-findings": "\uD83D\uDD0D",
	"gap-analysis": "\uD83D\uDCCA",
	"security-findings": "\uD83D\uDD12",
	"summary-report": "\uD83D\uDCDD",
	"custom": "\uD83D\uDCCB",
};

const REQUIRED_ARTIFACT_TYPES: ArtifactType[] = ["design-doc", "test-plan", "review-findings", "summary-report"];

interface ArtifactRequirementStatus {
	type: ArtifactType;
	label: string;
	required: boolean;
	artifact: GoalArtifact | null;
}

function getArtifactStatuses(artifactList: GoalArtifact[]): ArtifactRequirementStatus[] {
	const byType = new Map<ArtifactType, GoalArtifact>();
	for (const a of artifactList) {
		const existing = byType.get(a.type);
		if (!existing || a.updatedAt > existing.updatedAt) {
			byType.set(a.type, a);
		}
	}

	const statuses: ArtifactRequirementStatus[] = [];
	for (const type of REQUIRED_ARTIFACT_TYPES) {
		statuses.push({
			type,
			label: ARTIFACT_TYPE_LABELS[type],
			required: true,
			artifact: byType.get(type) || null,
		});
	}
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

// ============================================================================
// COMMIT BADGE DERIVATION
// ============================================================================

type BadgeStatus = "pass" | "fail" | "stale" | "pending";

interface CommitBadges {
	tests?: BadgeStatus;
	review?: BadgeStatus;
}

function deriveBadges(commitList: CommitInfo[], taskList: Task[]): Map<string, CommitBadges> {
	const badges = new Map<string, CommitBadges>();
	for (const c of commitList) badges.set(c.sha, {});

	const testTasks = taskList.filter(t => t.type === "test" && t.commitSha);
	const reviewTasks = taskList.filter(t => t.type === "review" && t.commitSha);

	for (const task of testTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.tests = "pass";
		else if (task.state === "skipped") b.tests = "fail";
		else if (task.state === "in-progress") b.tests = "pending";
	}

	for (const task of reviewTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.review = "pass";
		else if (task.state === "skipped") b.review = "fail";
		else if (task.state === "in-progress") b.review = "pending";
	}

	return badges;
}

// ============================================================================
// TEAM ACTIONS
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

// ============================================================================
// SVG ICON HELPERS
// ============================================================================

const svgArrowLeft = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;
const svgPencil = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const svgTrash = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const svgPlay = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
const svgStop = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
const svgPlus = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
const svgChevronDown = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const svgTeam = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const svgGitBranch = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>`;
const svgMerge = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
const svgDollar = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
const svgFolder = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const svgTasks = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/></svg>`;
const svgAgents = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const svgCommit = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>`;
const svgFile = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>`;
const svgClock = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
const svgPhaseArrow = html`<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M0 6h16M13 2l4 4-4 4"/></svg>`;

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(goal: Goal): TemplateResult {
	const isTeamGoal = !!goal.team;

	return html`
		<div class="nav">
			<div class="nav-left">
				<button class="back-btn" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${svgArrowLeft}
				</button>
				<span class="nav-title">${goal.title}</span>
			</div>
			<div class="nav-right">
				<button class="btn-icon" @click=${() => showGoalDialog(goal)} title="Edit goal">${svgPencil}</button>
				<button class="btn-icon danger" @click=${() => deleteGoal(goal.id)} title="Delete goal">${svgTrash}</button>
				${isTeamGoal ? renderTeamButton(goal) : renderSessionButton(goal)}
			</div>
		</div>
	`;
}

function renderTeamButton(goal: Goal): TemplateResult {
	if (teamActive) {
		return html`
			<div class="btn-split">
				<button class="btn-split-main danger" @click=${() => handleEndTeam(goal.id)} ?disabled=${teamStopping}>
					${svgStop}
					<span>${teamStopping ? "Stopping\u2026" : "Stop Team"}</span>
				</button>
			</div>
		`;
	}
	return html`
		<div class="btn-split">
			<button class="btn-split-main" @click=${() => handleStartTeam(goal.id)} ?disabled=${teamStarting}>
				${svgPlay}
				<span>${teamStarting ? "Starting\u2026" : "Start Team"}</span>
			</button>
		</div>
	`;
}

function renderSessionButton(goal: Goal): TemplateResult {
	return html`
		<div class="btn-split">
			<button class="btn-split-main" @click=${() => createAndConnectSession(goal.id)}>
				${svgPlus}
				New Session
			</button>
			<button class="btn-split-chevron" @click=${(e: Event) => { e.stopPropagation(); toggleRoleDropdown(); }} title="Choose role">
				${svgChevronDown}
			</button>
			${roleDropdownOpen ? html`
				<div class="role-dropdown open" @click=${(e: Event) => e.stopPropagation()}>
					${state.roles.length === 0
						? html`<div class="role-dropdown-item" style="color:var(--text-tertiary)">No roles defined</div>`
						: state.roles.map(role => html`
							<button class="role-dropdown-item" @click=${() => { roleDropdownOpen = false; createAndConnectSession(goal.id, role.name); }}>
								<span style="flex-shrink:0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
								<span class="role-label">${role.label}</span>
							</button>
						`)}
				</div>
			` : nothing}
		</div>
	`;
}

async function toggleRoleDropdown(): Promise<void> {
	if (roleDropdownOpen) {
		roleDropdownOpen = false;
		renderApp();
		return;
	}
	if (state.roles.length === 0) await fetchRoles();
	roleDropdownOpen = true;
	renderApp();
}

// Close role dropdown on outside click
document.addEventListener("click", () => {
	if (roleDropdownOpen) {
		roleDropdownOpen = false;
		renderApp();
	}
});

// ============================================================================
// RENDER: METADATA ROWS
// ============================================================================

function formatCost(cost: number): string {
	if (cost < 0.01) return "<$0.01";
	if (cost < 1) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

function renderMetaRows(goal: Goal): TemplateResult {
	const isTeamGoal = !!goal.team;
	const branch = goal.branch || "";
	const gs = gitStatus;

	return html`
		<div class="meta-rows">
			<div class="meta-row">
				<div class="meta-item">
					${svgTeam}
					<span class="meta-tag ${isTeamGoal ? "team-on" : "solo"}">${isTeamGoal ? "Team Mode" : "Solo Mode"}</span>
				</div>
				${goalCost && goalCost.totalCost > 0 ? html`
					<span class="meta-sep">\u00B7</span>
					<div class="meta-item" title="Input: ${formatTokens(goalCost.inputTokens)} | Output: ${formatTokens(goalCost.outputTokens)} | Cache read: ${formatTokens(goalCost.cacheReadTokens)} | Cache write: ${formatTokens(goalCost.cacheWriteTokens)}">
						${svgDollar}
						<span class="meta-tag cost-tag">${formatCost(goalCost.totalCost)}</span>
						<span class="meta-label">${formatTokens(goalCost.inputTokens + goalCost.outputTokens)} tokens</span>
					</div>
				` : nothing}
			</div>
			${branch || gs ? html`
				<div class="meta-row dashboard-git-row">
					<git-status-widget
						.branch=${gs?.branch ?? branch}
						.primaryBranch=${gs?.primaryBranch ?? "master"}
						.isOnPrimary=${gs?.isOnPrimary ?? false}
						.clean=${gs?.clean ?? true}
						.hasUpstream=${true}
						.ahead=${0}
						.behind=${0}
						.aheadOfPrimary=${gs?.aheadOfPrimary ?? 0}
						.behindPrimary=${gs?.behindPrimary ?? 0}
						.mergedIntoPrimary=${gs?.mergedIntoPrimary ?? false}
						.unpushed=${false}
						.statusFiles=${[]}
						.loading=${!gs && !!branch}
					></git-status-widget>
					${goal.worktreePath ? html`
						<span class="meta-sep">\u00B7</span>
						<div class="meta-item">
							${svgFolder}
							<span class="meta-value mono">${goal.worktreePath}</span>
						</div>
					` : nothing}
				</div>
			` : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: SUMMARY ROW
// ============================================================================

function renderSummaryRow(taskList: Task[], agentList: TeamAgent[]): TemplateResult {
	const total = taskList.length;
	const done = taskList.filter((t) => t.state === "complete").length;
	const inProgress = taskList.filter((t) => t.state === "in-progress").length;
	const failed = taskList.filter((t) => t.state === "skipped").length;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const circumference = 2 * Math.PI * 14; // radius 14
	const offset = circumference - (pct / 100) * circumference;

	const workingAgents = agentList.filter(a => a.status === "streaming").length;
	const idleAgents = agentList.length - workingAgents;

	return html`
		<div class="summary-row">
			<div class="summary-ring">
				<div class="ring-container">
					<svg class="ring-bg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14"/></svg>
					<svg class="ring-fg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/></svg>
					<div class="ring-label">${pct}%</div>
				</div>
				<div>
					<div class="ring-text">${done}/${total} tasks</div>
					<div class="ring-sub">complete</div>
				</div>
			</div>
			<div class="summary-stats">
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:oklch(0.72 0.15 250)">${inProgress}</span>
					<span class="mini-stat-label">Active</span>
				</div>
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:var(--destructive)">${failed}</span>
					<span class="mini-stat-label">Failed</span>
				</div>
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:oklch(0.72 0.15 145)">${agentList.length}</span>
					<span class="mini-stat-label">Agents</span>
				</div>
			</div>
			${agentList.length > 0 ? html`
				<div class="summary-agents">
					<div class="bobbit-row">
						${agentList.map(agent => {
							const session = state.gatewaySessions.find(s => s.id === agent.sessionId);
							return statusBobbit(
								session?.status ?? agent.status,
								session?.isCompacting ?? false,
								agent.sessionId,
								false,
								session?.isAborting ?? false,
								agent.role === "team-lead",
								agent.role === "coder",
								session?.accessory,
							);
						})}
					</div>
					<span class="bobbit-mini-label">${workingAgents} working, ${idleAgents} idle</span>
				</div>
			` : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: PHASE PIPELINE
// ============================================================================

function renderPhasePipeline(artifactList: GoalArtifact[]): TemplateResult {
	const currentPhase = derivePhase(artifactList, tasks);
	const currentIdx = PHASES.findIndex((p) => p.phase === currentPhase);

	return html`
		<div class="phase-pipeline">
			${PHASES.map((p, i) => {
				const isDone = i < currentIdx;
				const isActive = i === currentIdx;
				const arrowClass = isDone ? "done" : isActive ? "active" : "";
				const nodeClass = isDone ? "done" : isActive ? "active" : "";

				return html`
					${i > 0 ? html`<div class="phase-arrow ${arrowClass}">${svgPhaseArrow}</div>` : nothing}
					<div class="phase-node ${nodeClass}">
						${isDone ? html`<span class="phase-check">\u2713</span>` : nothing}
						${p.label}
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: TAB BAR
// ============================================================================

function setTab(tab: typeof dashboardTab): void {
	dashboardTab = tab;
	renderApp();
}

function renderTabBar(): TemplateResult {
	const tabs: Array<{ id: typeof dashboardTab; label: string; icon: TemplateResult; count: number }> = [
		{ id: "tasks", label: "Tasks", icon: svgTasks, count: tasks.length },
		{ id: "agents", label: "Agents", icon: svgAgents, count: agents.length },
		{ id: "commits", label: "Commits", icon: svgCommit, count: commits.length },
		{ id: "artifacts", label: "Artifacts", icon: svgFile, count: artifacts.length },
	];

	return html`
		<div class="tab-bar">
			${tabs.map(t => html`
				<div class="tab ${dashboardTab === t.id ? "active" : ""}" @click=${() => setTab(t.id)}>
					${t.icon}
					${t.label}
					<span class="tab-count">${t.count}</span>
				</div>
			`)}
		</div>
	`;
}

// ============================================================================
// RENDER: TASKS TAB
// ============================================================================

function statusChipClass(s: TaskState): string {
	switch (s) {
		case "todo": return "chip-todo";
		case "in-progress": return "chip-progress";
		case "complete": return "chip-done";
		case "blocked": return "chip-blocked";
		case "skipped": return "chip-failed";
	}
}

function statusLabel(s: TaskState): string {
	switch (s) {
		case "todo": return "Backlog";
		case "in-progress": return "In Progress";
		case "complete": return "Done";
		case "blocked": return "Blocked";
		case "skipped": return "Failed";
	}
}

function renderTasksTab(): TemplateResult {
	if (tasks.length === 0) {
		return html`<div class="tab-empty">${svgTasks}<span>No tasks yet</span></div>`;
	}

	return html`
		<div class="tab-panel-inner" style="padding-top:0;">
			<table class="task-table">
				<thead><tr>
					<th style="width:35%">Task</th>
					<th style="width:10%">Type</th>
					<th style="width:14%">Status</th>
					<th style="width:20%">Assignee</th>
					<th style="width:8%">Time</th>
				</tr></thead>
				<tbody>
					${tasks.map(task => {
						const isDone = task.state === "complete";
						const isFailed = task.state === "skipped";
						const assignee = findAssigneeSession(task.assignedSessionId);
						const color = typeColor(task.type);

						return html`
							<tr style="${isDone ? "opacity:0.55" : ""}">
								<td class="task-title-cell">
									${task.title}
									${isFailed && task.resultSummary ? html`
										<div style="font-size:11px;color:var(--destructive);margin-top:3px;">${task.resultSummary}</div>
									` : nothing}
								</td>
								<td><span class="type-tag" style="background:${color}20;color:${color}">${typeLabel(task.type)}</span></td>
								<td><span class="status-chip ${statusChipClass(task.state)}"><span class="dot"></span>${statusLabel(task.state)}</span></td>
								<td>
									${assignee
										? html`<div class="assignee-cell assignee-cell-link" @click=${(e: Event) => { e.stopPropagation(); connectToSession(assignee.id, true); }}>
											${statusBobbit(assignee.status, assignee.isCompacting, assignee.id, false, assignee.isAborting, assignee.role === "team-lead", assignee.role === "coder", assignee.accessory)}
											${assignee.title || assignee.id.slice(0, 8)}
										</div>`
										: html`<span style="font-size:12px;color:var(--text-tertiary)">Unassigned</span>`
									}
								</td>
								<td class="elapsed-cell">${getElapsedTime(task)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		</div>
	`;
}

// ============================================================================
// RENDER: AGENTS TAB
// ============================================================================

function renderAgentsTab(): TemplateResult {
	if (agents.length === 0) {
		return html`<div class="tab-empty">${svgAgents}<span>No active agents</span></div>`;
	}

	return html`
		<div class="tab-panel-inner">
			<div class="agent-grid">
				${agents.map(agent => {
					const session = state.gatewaySessions.find(s => s.id === agent.sessionId);
					const isWorking = agent.status === "streaming";
					const roleColor = getRoleColor(agent.role);
					const tasksDone = tasks.filter(t => t.assignedSessionId === agent.sessionId && t.state === "complete").length;
					const agentCommits = commits.filter(c => {
						const s = state.gatewaySessions.find(gs => gs.id === agent.sessionId);
						return s && c.author === (s.title || s.id.slice(0, 8));
					}).length;
					const elapsed = Date.now() - agent.createdAt;
					const mins = Math.floor(elapsed / 60_000);
					const timeStr = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;

					return html`
						<div class="agent-card" @click=${() => connectToSession(agent.sessionId, true)}>
							<div class="agent-card-bobbit">
								${statusBobbit(
									session?.status ?? agent.status,
									session?.isCompacting ?? false,
									agent.sessionId,
									false,
									session?.isAborting ?? false,
									agent.role === "team-lead",
									agent.role === "coder",
									session?.accessory,
								)}
							</div>
							<div class="agent-card-info">
								<div class="agent-card-name-row">
									<span class="agent-card-name">${formatAgentName(agent)}</span>
									<span class="role-tag" style="background:${roleColor.bg};color:${roleColor.text}">${getRoleLabel(agent.role)}</span>
									<span class="status-indicator ${isWorking ? "working" : "idle"}"></span>
								</div>
								<div class="agent-card-task">${agent.task || "No active task"}</div>
								<div class="agent-card-meta">
									<div class="agent-card-meta-item">${svgTasks} ${tasksDone} completed</div>
									${agentCommits > 0 ? html`<div class="agent-card-meta-item">${svgCommit} ${agentCommits} commits</div>` : nothing}
									<div class="agent-card-meta-item">${svgClock} ${timeStr}</div>
								</div>
							</div>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: COMMITS TAB
// ============================================================================

function renderCommitsTab(): TemplateResult {
	if (commits.length === 0) {
		return html`<div class="tab-empty">${svgCommit}<span>No commits found on this branch</span></div>`;
	}

	const badges = deriveBadges(commits, tasks);

	return html`
		<div class="tab-panel-inner" style="padding-top:0;">
			<div class="commit-list">
				${commits.map((commit, index) => {
					const isHead = index === 0;
					const b = badges.get(commit.sha) || {};
					return html`
						<div class="commit-row">
							<div class="commit-dot-col"><div class="cdot ${isHead ? "head" : ""}"></div></div>
							<code class="commit-sha2">${commit.shortSha}</code>
							<div class="commit-msg2">${commit.message}</div>
							<div class="commit-badges2">
								${b.tests === "pass" ? html`<span class="cbadge cbadge-pass">\u2713 Tests</span>` : nothing}
								${b.tests === "fail" ? html`<span class="cbadge cbadge-fail">\u2717 Tests</span>` : nothing}
								${b.tests === "pending" ? html`<span class="cbadge cbadge-pending">\u23F3 Tests</span>` : nothing}
								${b.review === "pass" ? html`<span class="cbadge cbadge-pass">\u2713 Review</span>` : nothing}
								${b.review === "fail" ? html`<span class="cbadge cbadge-fail">\u2717 Review</span>` : nothing}
								${b.review === "pending" ? html`<span class="cbadge cbadge-pending">\u23F3 Review</span>` : nothing}
							</div>
							<div class="commit-author2">${commit.author}</div>
							<div class="commit-time2">${formatRelativeTime(commit.timestamp)}</div>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: ARTIFACTS TAB
// ============================================================================

function renderArtifactsTab(): TemplateResult {
	const statuses = getArtifactStatuses(artifacts);

	if (statuses.length === 0) {
		return html`<div class="tab-empty">${svgFile}<span>No artifacts yet</span></div>`;
	}

	return html`
		<div class="tab-panel-inner" style="padding-top:0;">
			<div class="artifact-list">
				${statuses.map(status => {
					const { type, label, required, artifact } = status;
					const iconStr = ARTIFACT_TYPE_ICONS[type] || "\uD83D\uDCCB";
					const exists = artifact != null;
					const isMissing = !exists;
					const isExpanded = artifact ? expandedArtifactIds.has(artifact.id) : false;

					return html`
						<div class="artifact-item ${isMissing ? "missing" : ""}"
							@click=${() => artifact && toggleArtifactExpand(artifact.id)}>
							<div class="artifact-status-icon ${exists ? "exists" : "missing-icon"}">${iconStr}</div>
							<div class="artifact-main">
								<div class="artifact-name-row">
									<span class="artifact-name">${label}</span>
									${required ? html`<span class="artifact-badge badge-required">Required</span>` : nothing}
									${exists ? html`<span class="artifact-badge badge-version">v${artifact!.version}</span>` : nothing}
									${isMissing ? html`<span class="artifact-badge badge-missing-label">Missing</span>` : nothing}
								</div>
								<div class="artifact-detail">
									${exists ? html`
										<span>${formatRelativeTime(artifact!.updatedAt)}</span>
										${artifact!.producedBy ? html`
											<span class="artifact-detail-sep">\u00B7</span>
											<span>${(() => {
												const s = state.gatewaySessions.find(gs => gs.id === artifact!.producedBy);
												return s?.title || artifact!.producedBy.slice(0, 8);
											})()}</span>
										` : nothing}
									` : nothing}
									${isMissing && required ? html`
										<span class="artifact-blocks">\u26A0 Blocks ${type === "review-findings" ? "goal completion" : "implementation tasks"}</span>
									` : nothing}
									${isMissing && !required ? html`<span>Optional</span>` : nothing}
								</div>
							</div>
							${exists ? html`
								<div class="artifact-right"><span class="artifact-view-btn">${isExpanded ? "Hide" : "View"}</span></div>
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
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: MAIN DASHBOARD
// ============================================================================

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

	const activeTab = dashboardTab;

	return html`
		<div class="dashboard-container">
			${renderNavBar(currentGoal)}
			${renderMetaRows(currentGoal)}
			${renderSummaryRow(tasks, agents)}
			${renderPhasePipeline(artifacts)}
			${renderTabBar()}
			<div class="tab-content">
				<div class="tab-panel ${activeTab === "tasks" ? "active" : ""}">${activeTab === "tasks" ? renderTasksTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "agents" ? "active" : ""}">${activeTab === "agents" ? renderAgentsTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "commits" ? "active" : ""}">${activeTab === "commits" ? renderCommitsTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "artifacts" ? "active" : ""}">${activeTab === "artifacts" ? renderArtifactsTab() : nothing}</div>
			</div>
		</div>
	`;
}

// ============================================================================
// BACKWARD COMPAT: renderAgentPanel (exported but only used internally before)
// ============================================================================

export function renderAgentPanel(agentList: TeamAgent[]): TemplateResult {
	return renderAgentsTab();
}
