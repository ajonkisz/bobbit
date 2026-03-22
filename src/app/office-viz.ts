// ============================================================================
// ISOMETRIC OFFICE VISUALIZATION
// ============================================================================

import { html, type TemplateResult } from "lit";
import { gatewayFetch } from "./api.js";
import { statusBobbit } from "./session-colors.js";
import { renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// TYPES
// ============================================================================

interface OfficeSession {
	id: string;
	title: string;
	status: string;
	colorIndex: number;
	goalId?: string;
	accessory?: string;
	role?: string;
}

interface OfficeGoal {
	id: string;
	title: string;
	state: string;
	taskCounts: { todo: number; inProgress: number; complete: number };
}

// ============================================================================
// STATE
// ============================================================================

let sessions: OfficeSession[] = [];
let goals: OfficeGoal[] = [];
let sessionPollTimer: ReturnType<typeof setInterval> | null = null;
let goalPollTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// POLLING
// ============================================================================

async function pollSessions(): Promise<void> {
	try {
		const res = await gatewayFetch("/api/sessions");
		if (!res.ok) return;
		const data = await res.json();
		const rawSessions = data.sessions || [];
		sessions = rawSessions
			.filter((s: any) => !s.delegateOf)
			.map((s: any) => ({
				id: s.id,
				title: s.title || "Untitled",
				status: s.status || "idle",
				colorIndex: s.colorIndex ?? 0,
				goalId: s.goalId,
				accessory: s.accessory,
				role: s.role,
			}));
		renderApp();
	} catch {
		/* ignore polling errors */
	}
}

async function pollGoals(): Promise<void> {
	try {
		const res = await gatewayFetch("/api/goals");
		if (!res.ok) return;
		const data = await res.json();
		const rawGoals = data.goals || [];

		const newGoals: OfficeGoal[] = [];
		for (const g of rawGoals) {
			const taskCounts = { todo: 0, inProgress: 0, complete: 0 };
			try {
				const taskRes = await gatewayFetch(`/api/goals/${g.id}/tasks`);
				if (taskRes.ok) {
					const taskData = await taskRes.json();
					const tasks = taskData.tasks || [];
					for (const t of tasks) {
						if (t.state === "todo") taskCounts.todo++;
						else if (t.state === "in-progress" || t.state === "blocked") taskCounts.inProgress++;
						else if (t.state === "complete" || t.state === "skipped") taskCounts.complete++;
					}
				}
			} catch {
				/* ignore */
			}
			newGoals.push({
				id: g.id,
				title: g.title || "Untitled Goal",
				state: g.state || "todo",
				taskCounts,
			});
		}
		goals = newGoals;
		renderApp();
	} catch {
		/* ignore polling errors */
	}
}

// ============================================================================
// LIFECYCLE
// ============================================================================

/** Load data and start polling for the office visualization */
export function loadOfficeData(): void {
	// Clear any previous timers
	clearOfficeState();
	// Initial fetches
	pollSessions();
	pollGoals();
	// Start polling
	sessionPollTimer = setInterval(pollSessions, 3000);
	goalPollTimer = setInterval(pollGoals, 5000);
}

/** Stop polling and clean up */
export function clearOfficeState(): void {
	if (sessionPollTimer) {
		clearInterval(sessionPollTimer);
		sessionPollTimer = null;
	}
	if (goalPollTimer) {
		clearInterval(goalPollTimer);
		goalPollTimer = null;
	}
}

// ============================================================================
// LAYOUT ENGINE
// ============================================================================

interface DeskPosition {
	session: OfficeSession;
	x: number;
	y: number;
}

interface WhiteboardPosition {
	goal: OfficeGoal;
	x: number;
	y: number;
}

function computeLayout(): { desks: DeskPosition[]; whiteboards: WhiteboardPosition[] } {
	const COLS = 4;
	const H_SPACING = 140;
	const V_SPACING = 100;
	const START_X = 200;
	const START_Y = 150;

	const desks: DeskPosition[] = [];
	const whiteboards: WhiteboardPosition[] = [];

	// Group sessions by goalId
	const goalGroups = new Map<string, OfficeSession[]>();
	const ungrouped: OfficeSession[] = [];

	for (const s of sessions) {
		if (s.goalId) {
			if (!goalGroups.has(s.goalId)) goalGroups.set(s.goalId, []);
			goalGroups.get(s.goalId)!.push(s);
		} else {
			ungrouped.push(s);
		}
	}

	let row = 0;
	let col = 0;

	// Place goal-grouped sessions first
	for (const goal of goals) {
		const groupSessions = goalGroups.get(goal.id) || [];
		if (groupSessions.length === 0 && goal.state !== "in-progress") continue;

		// Place whiteboard at the start of each goal cluster row
		if (col > 0) {
			row++;
			col = 0;
		}

		whiteboards.push({
			goal,
			x: START_X + col * H_SPACING - 30,
			y: START_Y + row * V_SPACING - 40,
		});

		// Place desks for this goal's sessions
		for (const s of groupSessions) {
			if (col >= COLS) {
				col = 0;
				row++;
			}
			desks.push({
				session: s,
				x: START_X + col * H_SPACING,
				y: START_Y + row * V_SPACING,
			});
			col++;
		}

		if (groupSessions.length > 0) {
			row++;
			col = 0;
		}
	}

	// Place orphan whiteboards (goals with no sessions)
	for (const goal of goals) {
		const hasDesk = whiteboards.some((w) => w.goal.id === goal.id);
		if (!hasDesk) {
			whiteboards.push({
				goal,
				x: START_X + col * H_SPACING - 30,
				y: START_Y + row * V_SPACING - 40,
			});
		}
	}

	// Place ungrouped sessions
	for (const s of ungrouped) {
		if (col >= COLS) {
			col = 0;
			row++;
		}
		desks.push({
			session: s,
			x: START_X + col * H_SPACING,
			y: START_Y + row * V_SPACING,
		});
		col++;
	}

	return { desks, whiteboards };
}

// ============================================================================
// RENDERERS
// ============================================================================

function renderDesk(dp: DeskPosition): TemplateResult {
	const s = dp.session;
	const isStreaming = s.status === "streaming";
	const isTerminated = s.status === "terminated";
	const isStarting = s.status === "starting";
	const noDesaturate = isStreaming || isStarting;

	const bobbit = statusBobbit(
		s.status,
		false,       // isCompacting
		s.id,        // sessionId (for hue)
		false,       // isSelected
		false,       // isAborting
		s.role === "team-lead",
		s.role === "coder",
		s.accessory,
		noDesaturate,
	);

	return html`
		<div class="office-desk ${isTerminated ? "office-desk--terminated" : ""}"
			style="left: ${dp.x}px; top: ${dp.y}px;">
			<div class="desk-surface"></div>
			<div class="desk-monitor">
				<div class="monitor-screen ${isStreaming ? "monitor-screen--active" : ""}"></div>
			</div>
			<div class="desk-bobbit">${bobbit}</div>
			${isStreaming ? html`
				<div class="typing-dots">
					<div class="typing-dot"></div>
					<div class="typing-dot"></div>
					<div class="typing-dot"></div>
				</div>
			` : ""}
			<div class="desk-label">${truncate(s.title, 16)}</div>
		</div>
	`;
}

function renderWhiteboard(wp: WhiteboardPosition): TemplateResult {
	const g = wp.goal;
	const stateClass =
		g.state === "in-progress" ? "state-dot--active" :
		g.state === "complete" ? "state-dot--complete" :
		g.state === "shelved" ? "state-dot--shelved" :
		"state-dot--todo";

	const stateLabel =
		g.state === "in-progress" ? "Active" :
		g.state === "complete" ? "Complete" :
		g.state === "shelved" ? "Shelved" :
		"Todo";

	return html`
		<div class="office-whiteboard" style="left: ${wp.x}px; top: ${wp.y}px;">
			<div class="whiteboard-title">${truncate(g.title, 18)}</div>
			<div class="whiteboard-state">
				<div class="state-dot ${stateClass}"></div>
				<span>${stateLabel}</span>
			</div>
		</div>
	`;
}

function renderKanban(): TemplateResult {
	// Aggregate task counts across all goals
	let totalTodo = 0;
	let totalProgress = 0;
	let totalComplete = 0;
	for (const g of goals) {
		totalTodo += g.taskCounts.todo;
		totalProgress += g.taskCounts.inProgress;
		totalComplete += g.taskCounts.complete;
	}

	if (totalTodo === 0 && totalProgress === 0 && totalComplete === 0) {
		return html``;
	}

	// Place kanban board at a fixed position
	const kanbanX = 800;
	const kanbanY = 50;

	const renderStickies = (count: number, cls: string) => {
		const stickies = [];
		const display = Math.min(count, 5);
		for (let i = 0; i < display; i++) {
			stickies.push(html`<div class="kanban-sticky ${cls}"></div>`);
		}
		return stickies;
	};

	return html`
		<div class="office-kanban" style="left: ${kanbanX}px; top: ${kanbanY}px;">
			<div class="kanban-title">Tasks</div>
			<div class="kanban-columns">
				<div class="kanban-col">
					<div class="kanban-col-label">Todo</div>
					${renderStickies(totalTodo, "kanban-sticky--todo")}
					<div class="kanban-count">${totalTodo}</div>
				</div>
				<div class="kanban-col">
					<div class="kanban-col-label">WIP</div>
					${renderStickies(totalProgress, "kanban-sticky--progress")}
					<div class="kanban-count">${totalProgress}</div>
				</div>
				<div class="kanban-col">
					<div class="kanban-col-label">Done</div>
					${renderStickies(totalComplete, "kanban-sticky--complete")}
					<div class="kanban-count">${totalComplete}</div>
				</div>
			</div>
		</div>
	`;
}

function renderAmbient(): TemplateResult {
	// Pixel-art potted plants via box-shadow
	const plantShadow = `
		3px 0px 0 var(--plant-leaf), 5px 0px 0 var(--plant-leaf),
		2px 1px 0 var(--plant-leaf), 3px 1px 0 var(--plant-leaf-light), 4px 1px 0 var(--plant-leaf), 5px 1px 0 var(--plant-leaf-light), 6px 1px 0 var(--plant-leaf),
		3px 2px 0 var(--plant-leaf), 4px 2px 0 var(--plant-leaf-light), 5px 2px 0 var(--plant-leaf),
		4px 3px 0 #5a3a1a, 4px 4px 0 #5a3a1a,
		3px 5px 0 var(--plant-pot), 4px 5px 0 var(--plant-pot), 5px 5px 0 var(--plant-pot),
		3px 6px 0 var(--plant-pot), 4px 6px 0 var(--plant-pot), 5px 6px 0 var(--plant-pot),
		3px 7px 0 var(--plant-pot), 4px 7px 0 var(--plant-pot), 5px 7px 0 var(--plant-pot)
	`;

	return html`
		<div class="office-plant" style="left: 100px; top: 80px;">
			<span class="plant-sprite" style="box-shadow: ${plantShadow};"></span>
		</div>
		<div class="office-plant" style="left: 900px; top: 600px;">
			<span class="plant-sprite" style="box-shadow: ${plantShadow};"></span>
		</div>
		<div class="office-plant" style="left: 500px; top: 750px;">
			<span class="plant-sprite" style="box-shadow: ${plantShadow};"></span>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

/** Render the office page (called by doRenderApp) */
export function renderOfficePage(): TemplateResult {
	const { desks, whiteboards } = computeLayout();

	return html`
		<div class="office-page">
			<button class="office-back-btn" @click=${() => setHashRoute("landing")}>
				\u2190 Back
			</button>
			<div class="office-viewport">
				<div class="office-floor">
					${desks.map((dp) => renderDesk(dp))}
					${whiteboards.map((wp) => renderWhiteboard(wp))}
					${renderKanban()}
					${renderAmbient()}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// HELPERS
// ============================================================================

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return str.slice(0, max - 1) + "\u2026";
}
