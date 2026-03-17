import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, render } from "lit";
import {
	ArrowLeft,
	Crosshair,
	LayoutDashboard,
	Pencil,
	Plus,
	Trash2,
	Users,
	CheckCircle2,
	Clock,
	Activity,
	GitBranch,
} from "lucide";
import {
	state,
	renderApp,
	GOAL_STATE_LABELS,
	GOAL_STATE_COLORS,
	type Goal,
	type GoalState,
} from "./state.js";
import { gatewayFetch, refreshSessions, deleteGoal, startSwarm } from "./api.js";
import { showGoalDialog } from "./dialogs.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { setHashRoute } from "./routing.js";
import { goalStateIcon } from "./render-helpers.js";

// ============================================================================
// NAVIGATION
// ============================================================================

export function navigateToGoalDashboard(goalId: string): void {
	if (state.remoteAgent) {
		state.remoteAgent.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
	}
	state.goalDashboardId = goalId;
	setHashRoute("goal-dashboard", goalId);
	renderApp();
}

// ============================================================================
// DATA TYPES
// ============================================================================

interface Task {
	id: string;
	title: string;
	type: "code" | "test" | "review";
	status: "backlog" | "in-progress" | "done" | "failed";
	assignee?: string;
	goalId: string;
	commitSha?: string;
	resultSummary?: string;
	createdAt: number;
	updatedAt: number;
	stale?: boolean;
}

interface SwarmAgent {
	sessionId: string;
	role: string;
	status: string;
	worktreePath?: string;
}

interface DashboardData {
	goal: Goal | null;
	tasks: Task[];
	agents: SwarmAgent[];
	loading: boolean;
	error: string;
}

let dashboardData: DashboardData = {
	goal: null,
	tasks: [],
	agents: [],
	loading: false,
	error: "",
};

// ============================================================================
// DATA FETCHING
// ============================================================================

let _lastFetchedGoalId: string | null = null;

export async function fetchDashboardData(goalId: string): Promise<void> {
	if (_lastFetchedGoalId === goalId && dashboardData.goal) return;
	_lastFetchedGoalId = goalId;

	dashboardData = { goal: null, tasks: [], agents: [], loading: true, error: "" };
	renderApp();

	try {
		// Fetch goal data — required
		const goalRes = await gatewayFetch(`/api/goals/${goalId}`);
		if (!goalRes.ok) {
			dashboardData.error = "Goal not found";
			dashboardData.loading = false;
			renderApp();
			return;
		}
		dashboardData.goal = await goalRes.json();

		// Fetch tasks (may 404 if task API not yet implemented)
		try {
			const tasksRes = await gatewayFetch(`/api/goals/${goalId}/tasks`);
			if (tasksRes.ok) {
				const data = await tasksRes.json();
				dashboardData.tasks = data.tasks || [];
			}
		} catch { /* tasks API not available yet */ }

		// Fetch swarm agents (may 404 if not a swarm goal)
		try {
			const agentsRes = await gatewayFetch(`/api/goals/${goalId}/swarm/agents`);
			if (agentsRes.ok) {
				const data = await agentsRes.json();
				dashboardData.agents = data.agents || [];
			}
		} catch { /* swarm API not available */ }

		dashboardData.loading = false;
		renderApp();
	} catch (err) {
		dashboardData.error = err instanceof Error ? err.message : "Failed to load dashboard";
		dashboardData.loading = false;
		renderApp();
	}
}

export function resetDashboardData(): void {
	_lastFetchedGoalId = null;
	dashboardData = { goal: null, tasks: [], agents: [], loading: false, error: "" };
}

// ============================================================================
// HEALTH DERIVATION
// ============================================================================

function deriveHealth(tasks: Task[]): { label: string; color: string; cssClass: string } {
	if (tasks.length === 0) return { label: "No tasks", color: "var(--muted-foreground)", cssClass: "text-muted-foreground" };
	const allDone = tasks.every((t) => t.status === "done");
	const hasFailed = tasks.some((t) => t.status === "failed");
	const hasStale = tasks.some((t) => t.stale);
	if (hasFailed) return { label: "Needs attention", color: "var(--destructive)", cssClass: "text-red-500" };
	if (hasStale) return { label: "Stale results", color: "#eab308", cssClass: "text-yellow-500" };
	if (allDone) return { label: "Healthy", color: "#22c55e", cssClass: "text-green-500" };
	return { label: "In progress", color: "#3b82f6", cssClass: "text-blue-500" };
}

// ============================================================================
// RENDER
// ============================================================================

export function renderGoalDashboard(): ReturnType<typeof html> {
	const goalId = state.goalDashboardId;
	if (!goalId) return html``;

	// Trigger data fetch if needed
	if (_lastFetchedGoalId !== goalId) {
		fetchDashboardData(goalId);
	}

	if (dashboardData.loading) {
		return html`
			<div class="goal-dashboard flex-1 flex flex-col items-center justify-center gap-4 bg-background text-foreground">
				<svg class="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
				<span class="text-sm text-muted-foreground">Loading dashboard…</span>
			</div>
		`;
	}

	if (dashboardData.error || !dashboardData.goal) {
		return html`
			<div class="goal-dashboard flex-1 flex flex-col items-center justify-center gap-4 bg-background text-foreground">
				<p class="text-sm text-red-500">${dashboardData.error || "Goal not found"}</p>
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => { state.goalDashboardId = null; setHashRoute("landing"); renderApp(); },
					children: html`<span class="inline-flex items-center gap-1.5">${icon(ArrowLeft, "sm")} Back</span>`,
				})}
			</div>
		`;
	}

	const goal = dashboardData.goal;
	const tasks = dashboardData.tasks;
	const agents = dashboardData.agents;
	const health = deriveHealth(tasks);

	const tasksByStatus = {
		backlog: tasks.filter((t) => t.status === "backlog"),
		"in-progress": tasks.filter((t) => t.status === "in-progress"),
		done: tasks.filter((t) => t.status === "done"),
		failed: tasks.filter((t) => t.status === "failed"),
	};

	const activeAgents = agents.filter((a) => a.status === "active" || a.status === "working");
	const goalSessions = state.gatewaySessions.filter((s) => s.goalId === goal.id || s.swarmGoalId === goal.id);

	return html`
		<div class="goal-dashboard flex-1 flex flex-col min-h-0 bg-background text-foreground overflow-hidden">
			<!-- Nav Bar -->
			<div class="gd-navbar shrink-0 flex items-center justify-between px-5 py-3 border-b border-border bg-card/80 backdrop-blur-sm">
				<div class="flex items-center gap-3 min-w-0">
					<button class="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						@click=${() => { state.goalDashboardId = null; setHashRoute("landing"); renderApp(); }}
						title="Back to sessions">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="flex items-center gap-2 min-w-0">
						<span class="shrink-0">${goalStateIcon(goal.state, 16)}</span>
						<h1 class="text-base font-semibold text-foreground truncate">${goal.title}</h1>
						${goal.branch ? html`
							<span class="flex items-center gap-1 text-xs text-muted-foreground font-mono bg-secondary/50 px-2 py-0.5 rounded-md shrink-0">
								${icon(GitBranch, "xs")}
								${goal.branch}
							</span>
						` : ""}
					</div>
				</div>
				<div class="flex items-center gap-1.5 shrink-0">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => showGoalDialog(goal),
						children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "xs")} Edit</span>`,
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => deleteGoal(goal.id),
						children: html`<span class="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive">${icon(Trash2, "xs")} Delete</span>`,
					})}
					${goal.swarm ? Button({
						variant: "default",
						size: "sm",
						onClick: async () => { const sid = await startSwarm(goal.id); if (sid) connectToSession(sid, true); },
						children: html`<span class="inline-flex items-center gap-1.5">🐝 Start Swarm</span>`,
					}) : ""}
					${Button({
						variant: "default",
						size: "sm",
						onClick: () => createAndConnectSession(goal.id),
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "xs")} New Session</span>`,
					})}
				</div>
			</div>

			<!-- Scrollable Content -->
			<div class="flex-1 overflow-y-auto">
				<!-- Summary Header -->
				<div class="gd-summary px-5 py-4 border-b border-border/50">
					<div class="flex items-center gap-6 flex-wrap">
						<div class="flex items-center gap-2">
							<div class="w-2.5 h-2.5 rounded-full" style="background:${health.color}"></div>
							<span class="text-sm font-medium ${health.cssClass}">${health.label}</span>
						</div>
						<div class="flex items-center gap-1.5 text-sm text-muted-foreground">
							${icon(CheckCircle2, "xs")}
							<span>${tasksByStatus.done.length}/${tasks.length} tasks done</span>
						</div>
						<div class="flex items-center gap-1.5 text-sm text-muted-foreground">
							${icon(Users, "xs")}
							<span>${activeAgents.length > 0 ? `${activeAgents.length} active agent${activeAgents.length !== 1 ? "s" : ""}` : `${goalSessions.length} session${goalSessions.length !== 1 ? "s" : ""}`}</span>
						</div>
						<div class="flex items-center gap-1.5 text-sm text-muted-foreground">
							${icon(Clock, "xs")}
							<span>${formatElapsed(goal.createdAt)}</span>
						</div>
						<span class="text-xs px-2 py-0.5 rounded-full border border-border ${GOAL_STATE_COLORS[goal.state]}">${GOAL_STATE_LABELS[goal.state]}</span>
					</div>
				</div>

				<!-- Dashboard Grid -->
				<div class="gd-grid grid gap-5 p-5" style="grid-template-columns: 1fr 1fr; grid-template-rows: auto auto;">
					<!-- Kanban Board -->
					<div class="gd-kanban col-span-2 rounded-lg border border-border bg-card p-4">
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(Activity, "sm")}
							Task Board
						</h2>
						${tasks.length > 0 ? html`
							<div class="grid grid-cols-4 gap-3" style="min-height:120px;">
								${renderKanbanColumn("Backlog", tasksByStatus.backlog, "text-muted-foreground")}
								${renderKanbanColumn("In Progress", tasksByStatus["in-progress"], "text-blue-500")}
								${renderKanbanColumn("Done", tasksByStatus.done, "text-green-500")}
								${renderKanbanColumn("Failed", tasksByStatus.failed, "text-red-500")}
							</div>
						` : html`
							<div class="flex flex-col items-center justify-center py-8 text-muted-foreground">
								<p class="text-sm">No tasks yet</p>
								<p class="text-xs mt-1">Tasks will appear here when the structured task API is available</p>
							</div>
						`}
					</div>

					<!-- Agent Activity Panel -->
					<div class="gd-agents rounded-lg border border-border bg-card p-4">
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(Users, "sm")}
							Agent Activity
						</h2>
						${goalSessions.length > 0 ? html`
							<div class="flex flex-col gap-2">
								${goalSessions.map((s) => html`
									<button class="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 hover:bg-secondary/50 transition-colors text-left w-full"
										@click=${() => connectToSession(s.id, true)}>
										<div class="w-2 h-2 rounded-full shrink-0 ${s.status === "streaming" ? "bg-green-500" : s.status === "idle" ? "bg-muted-foreground/40" : "bg-yellow-500"}"></div>
										<div class="flex-1 min-w-0">
											<div class="text-xs font-medium text-foreground truncate">${s.title || "Untitled"}</div>
											<div class="text-[10px] text-muted-foreground">${s.role || "session"} · ${s.status}</div>
										</div>
									</button>
								`)}
							</div>
						` : html`
							<div class="flex flex-col items-center justify-center py-6 text-muted-foreground">
								<p class="text-sm">No active agents</p>
								${goal.swarm ? html`
									<button class="text-xs text-primary hover:underline mt-1"
										@click=${async () => { const sid = await startSwarm(goal.id); if (sid) connectToSession(sid, true); }}>Start swarm</button>
								` : html`
									<button class="text-xs text-primary hover:underline mt-1"
										@click=${() => createAndConnectSession(goal.id)}>Create a session</button>
								`}
							</div>
						`}
					</div>

					<!-- Commit Timeline (placeholder) -->
					<div class="gd-timeline rounded-lg border border-border bg-card p-4">
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(GitBranch, "sm")}
							Commit Timeline
						</h2>
						<div class="flex flex-col items-center justify-center py-6 text-muted-foreground">
							<p class="text-sm">Coming soon</p>
							<p class="text-xs mt-1">Commit history with status badges will appear here</p>
						</div>
					</div>

					<!-- Reports Viewer (placeholder) -->
					<div class="gd-reports col-span-2 rounded-lg border border-border bg-card p-4">
						<h2 class="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
							${icon(LayoutDashboard, "sm")}
							Reports
						</h2>
						<div class="flex flex-col items-center justify-center py-6 text-muted-foreground">
							<p class="text-sm">Coming soon</p>
							<p class="text-xs mt-1">Code review and test suite reports will be embedded here</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// KANBAN COLUMN
// ============================================================================

function renderKanbanColumn(title: string, tasks: Task[], titleColor: string) {
	return html`
		<div class="flex flex-col gap-2">
			<div class="flex items-center justify-between">
				<span class="text-xs font-semibold ${titleColor} uppercase tracking-wider">${title}</span>
				<span class="text-[10px] text-muted-foreground bg-secondary/50 px-1.5 py-0.5 rounded-full">${tasks.length}</span>
			</div>
			<div class="flex flex-col gap-1.5 min-h-[60px]">
				${tasks.map((t) => html`
					<div class="px-2.5 py-2 rounded-md border border-border/50 bg-background hover:bg-secondary/30 transition-colors">
						<div class="text-xs font-medium text-foreground">${t.title}</div>
						<div class="flex items-center gap-2 mt-1">
							<span class="text-[10px] px-1.5 py-0.5 rounded-full ${taskTypeColor(t.type)}">${t.type}</span>
							${t.assignee ? html`<span class="text-[10px] text-muted-foreground">${t.assignee}</span>` : ""}
							${t.stale ? html`<span class="text-[10px] text-yellow-500 font-medium">stale</span>` : ""}
						</div>
					</div>
				`)}
			</div>
		</div>
	`;
}

function taskTypeColor(type: string): string {
	switch (type) {
		case "code": return "bg-blue-500/10 text-blue-500";
		case "test": return "bg-green-500/10 text-green-500";
		case "review": return "bg-purple-500/10 text-purple-500";
		default: return "bg-secondary text-muted-foreground";
	}
}

// ============================================================================
// HELPERS
// ============================================================================

function formatElapsed(createdAt: number): string {
	const ms = Date.now() - createdAt;
	const minutes = Math.floor(ms / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}
