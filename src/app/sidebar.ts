import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Crosshair, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Trash2 } from "lucide";
import {
	state,
	renderApp,
	activeSessionId,
	expandedGoals,
	ungroupedExpanded,
	setUngroupedExpanded,
	saveExpandedGoals,
	type Goal,
	type GoalState,
} from "./state.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { deleteGoal, startSwarm } from "./api.js";
import { refreshSessions } from "./api.js";
import { showGoalDialog } from "./dialogs.js";
import { setHashRoute } from "./routing.js";
import { statusBobbit, sessionAcronym, sessionColorMap } from "./session-colors.js";
import { renderSidebarSession, showSessionTooltip, hideSessionTooltip, SESSION_ROW_PY } from "./render-helpers.js";
import type { GatewaySession } from "./state.js";

// ============================================================================
// SIDEBAR TOGGLE
// ============================================================================

export function toggleSidebar(): void {
	state.sidebarCollapsed = !state.sidebarCollapsed;
	localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
	renderApp();
}

// ============================================================================
// SIDEBAR GOAL
// ============================================================================

function renderSidebarGoal(goal: Goal) {
	const isExpanded = expandedGoals.has(goal.id);
	const goalSessions = state.gatewaySessions.filter((s) => (s.goalId === goal.id || s.swarmGoalId === goal.id) && !s.delegateOf);
	const isCreatingHere = state.creatingSessionForGoalId === goal.id;

	return html`
		<div class="flex flex-col gap-0.5">
			<div class="group relative flex items-center gap-1 px-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/50 transition-colors"
				@click=${() => { if (isExpanded) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}
				@dblclick=${() => { if (goal.swarm) { const tl = goalSessions.find(s => s.role === "team-lead"); if (tl) connectToSession(tl.id, true); } }}>
				<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${isExpanded ? "▾" : "▸"}</span>

				<span class="flex-1 min-w-0 truncate text-[10px] text-muted-foreground uppercase tracking-wider font-medium ${goal.state === "shelved" ? "opacity-60" : ""}">${goal.title}</span>
				<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<button class="p-0.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
						@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); }}
						title="Goal dashboard">
						${icon(LayoutDashboard, "xs")}
					</button>
				</div>
			</div>
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5">
					${goalSessions.length === 0 && !isCreatingHere
						? html`<div class="pl-3 py-1 text-[10px] text-muted-foreground">
								${goal.swarm
									? html`No agents — <button class="text-primary hover:underline" @click=${async () => { const sid = await startSwarm(goal.id); if (sid) connectToSession(sid, false); }}>start swarm</button>`
									: html`No sessions — <button class="text-primary hover:underline" @click=${() => createAndConnectSession(goal.id)}>start one</button>`}
							</div>`
						: goalSessions.map(renderSidebarSession)}
					${isCreatingHere ? html`<div class="pl-3 py-1 text-[10px] text-muted-foreground flex items-center gap-1">
						<svg class="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
						Creating…
					</div>` : ""}
				</div>
			` : ""}
		</div>
	`;
}

// ============================================================================
// RENDER SIDEBAR
// ============================================================================

export function renderSidebar() {
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.delegateOf);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

	if (state.sidebarCollapsed) {
		return renderCollapsedSidebar(sortedGoals, ungroupedSessions);
	}

	return html`
		<div class="w-[240px] shrink-0 h-full flex flex-col sidebar-edge" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 py-2 px-0.5">
				${state.sessionsLoading
					? html`<div class="text-center py-6 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-6">
								<p class="text-xs text-red-500 mb-2">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground hover:text-foreground underline" @click=${refreshSessions}>Retry</button>
							</div>`
						: html`
							${sortedGoals.map((goal, i) => html`
								${i > 0 ? html`<div class="border-t border-border/50 my-1.5 mx-1"></div>` : ""}
								${renderSidebarGoal(goal)}
							`)}
							${sortedGoals.length > 0 ? html`
								<div class="border-t border-border/50 my-1.5 mx-1"></div>
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-1 px-1 py-0.5">
										<div class="flex-1 flex items-center gap-1 cursor-pointer hover:bg-secondary/30 rounded-md transition-colors"
											@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
											<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${ungroupedExpanded ? "▾" : "▸"}</span>
											<span class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
										</div>
										<button
											class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
											@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
											title="New session"
											?disabled=${state.creatingSession}
										>
											${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}
										</button>
									</div>
									${ungroupedExpanded ? ungroupedSessions.map(renderSidebarSession) : ""}
								</div>
							` : html`
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-1 px-1 py-0.5">
										<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:13px;">Sessions</span>
										<button
											class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
											@click=${() => createAndConnectSession()}
											title="New session"
											?disabled=${state.creatingSession}
										>
											${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}
										</button>
									</div>
									${ungroupedSessions.length === 0
										? html`<div class="text-center py-6">
												<p class="text-xs text-muted-foreground mb-2">No sessions</p>
												<button class="text-xs text-primary hover:underline" @click=${() => createAndConnectSession()}>Create one</button>
											</div>`
										: ungroupedSessions.map(renderSidebarSession)}
								</div>
							`}
						`
				}
			</div>
			<button
				class="flex items-center justify-end gap-1.5 px-3 py-2 w-full text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors border-t border-border/50"
				@click=${toggleSidebar}
				title="Collapse sidebar (Ctrl+[)"
			>
				<span>Collapse</span>
				${icon(PanelLeftClose, "sm")}
			</button>
		</div>
	`;
}

// ============================================================================
// COLLAPSED SIDEBAR
// ============================================================================

function renderCollapsedSidebar(sortedGoals: Goal[], ungroupedSessions: GatewaySession[]) {
	const allSessions = state.gatewaySessions;
	const ungrouped = allSessions.filter((s) => !s.goalId && !s.delegateOf);

	const renderCollapsedSession = (s: GatewaySession) => {
		const active = activeSessionId() === s.id;
		const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : s.title;
		return html`
			<button
				class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary" : "hover:bg-secondary/50"}"
				@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, s, displayTitle)}
				@mouseleave=${hideSessionTooltip}
				@click=${() => { if (!active) connectToSession(s.id, true); }}
			>
				${statusBobbit(s.status, s.isCompacting, s.id, active, s.isAborting, s.role === "team-lead", s.role === "coder")}
				<span class="text-[8px] font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(displayTitle)}</span>
			</button>
		`;
	};

	return html`
		<div class="w-14 shrink-0 h-full flex flex-col items-center sidebar-edge" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
				${sortedGoals.map((goal, i) => {
					const goalSessions = allSessions.filter((s) => s.goalId === goal.id || s.swarmGoalId === goal.id);
					const expanded = expandedGoals.has(goal.id);
					return html`
						${i > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						<button
							class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
							title=${goal.title}
							@click=${(e: Event) => { e.stopPropagation(); if (expandedGoals.has(goal.id)) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}
						>
							<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${expanded ? "▾" : "▸"}</span>
							<span class="text-[10px] font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(goal.title)}</span>
						</button>
						${expanded ? goalSessions.map(renderCollapsedSession) : ""}
					`;
				})}
				${sortedGoals.length > 0 ? html`
					<div class="w-7 border-t border-border/50 my-1.5"></div>
					<button
						class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
						title="Ungrouped sessions"
						@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}
					>
						<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${ungroupedExpanded ? "▾" : "▸"}</span>
						<span class="text-[10px] font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1;">SES</span>
					</button>
					${ungroupedExpanded ? ungrouped.map(renderCollapsedSession) : ""}
				` : ungrouped.map(renderCollapsedSession)}
			</div>
			<button
				class="p-2 mb-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
				@click=${toggleSidebar}
				title="Expand sidebar (Ctrl+[)"
			>
				${icon(PanelLeftOpen, "sm")}
			</button>
		</div>
	`;
}
