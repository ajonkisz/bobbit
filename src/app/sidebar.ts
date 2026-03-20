import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { ChevronDown, Layers, PanelLeftClose, PanelLeftOpen, Plus, Users, Wrench } from "lucide";
import {
	state,
	renderApp,
	activeSessionId,
	expandedGoals,
	ungroupedExpanded,
	setUngroupedExpanded,
	saveExpandedGoals,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	type Goal,
	type GoalState,
} from "./state.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { showGoalDialog } from "./dialogs.js";
import { refreshSessions, fetchRoles } from "./api.js";
import { statusBobbit, sessionAcronym } from "./session-colors.js";
import { renderGoalGroup, renderSessionRow, showSessionTooltip, hideSessionTooltip, SESSION_ROW_PY } from "./render-helpers.js";
import type { GatewaySession } from "./state.js";

// ============================================================================
// ROLE PICKER
// ============================================================================

/** Toggle role picker dropdown, fetching roles if needed. */
export async function toggleRolePicker(e: Event): Promise<void> {
	e.stopPropagation();
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
		return;
	}
	if (state.roles.length === 0) await fetchRoles();
	state.rolePickerOpen = true;
	renderApp();
}

export function renderRolePickerDropdown() {
	if (!state.rolePickerOpen) return "";
	return html`
		<div class="absolute right-0 top-full mt-1 z-50 rounded-md shadow-lg py-1 min-w-[140px]"
			style="background: var(--popover); border: 1px solid var(--border);"
			@click=${(e: Event) => e.stopPropagation()}>
			${state.roles.length === 0
				? html`<div class="px-3 py-2 text-xs text-muted-foreground">No roles defined</div>`
				: state.roles.map(role => html`
					<button class="w-full text-left px-3 py-2.5 text-sm hover:bg-secondary/50 active:bg-secondary text-foreground flex items-center gap-2"
						@click=${() => { state.rolePickerOpen = false; createAndConnectSession(undefined, role.name); }}>
						<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
						<span>${role.label}</span>
					</button>
				`)}
		</div>
	`;
}

// Close role picker on outside click
document.addEventListener("click", () => {
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
	}
});

// ============================================================================
// SIDEBAR TOGGLE
// ============================================================================

export function toggleSidebar(): void {
	state.sidebarCollapsed = !state.sidebarCollapsed;
	localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
	renderApp();
}

// ============================================================================
// SIDEBAR GOAL — uses unified renderGoalGroup from render-helpers.ts
// ============================================================================

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
			<div class="flex items-center border-b border-border/50 px-1 py-1">
				<button
					class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
					@click=${() => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); import("./routing.js").then((m) => m.setHashRoute("roles")); }}
					title="Manage roles"
				>
					${icon(Users, "sm")}
					<span>Roles</span>
				</button>
				<button
					class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
					@click=${() => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); import("./routing.js").then((m) => m.setHashRoute("tools")); }}
					title="Manage tools"
				>
					${icon(Wrench, "sm")}
					<span>Tools</span>
				</button>
				<button
					class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
					@click=${() => { import("./artifact-spec-page.js").then((m) => m.loadArtifactSpecPageData()); import("./routing.js").then((m) => m.setHashRoute("artifact-specs")); }}
					title="Manage artifact specs"
				>
					${icon(Layers, "sm")}
					<span>Specs</span>
				</button>
				<button
					class="flex-1 flex items-center justify-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded-md transition-colors"
					@click=${() => showGoalDialog()}
					title="New goal"
				>
					${icon(Plus, "sm")}
					<span>Goal</span>
				</button>
			</div>
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
								${renderGoalGroup(goal)}
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
										<div class="flex items-center relative">
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
											<button
												class="p-0 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
												@click=${toggleRolePicker}
												title="New session with role"
											>${icon(ChevronDown, "xs")}</button>
											${renderRolePickerDropdown()}
										</div>
									</div>
									${ungroupedExpanded ? ungroupedSessions.map(renderSessionRow) : ""}
								</div>
							` : html`
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-1 px-1 py-0.5">
										<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:13px;">Sessions</span>
										<div class="flex items-center relative">
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
											<button
												class="p-0 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
												@click=${toggleRolePicker}
												title="New session with role"
											>${icon(ChevronDown, "xs")}</button>
											${renderRolePickerDropdown()}
										</div>
									</div>
									${ungroupedSessions.length === 0
										? html`<div class="text-center py-6">
												<p class="text-xs text-muted-foreground mb-2">No sessions</p>
												<button class="text-xs text-primary hover:underline" @click=${() => createAndConnectSession()}>Create one</button>
											</div>`
										: ungroupedSessions.map(renderSessionRow)}
								</div>
							`}
						`
				}
			</div>
			<div class="flex items-center border-t border-border/50">
				<span class="flex-1"></span>
				<button
					class="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
					@click=${toggleSidebar}
					title="Collapse sidebar (Ctrl+[)"
				>
					<span>Collapse</span>
					${icon(PanelLeftClose, "sm")}
				</button>
			</div>
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
				${statusBobbit(s.status, s.isCompacting, s.id, active, s.isAborting, s.role === "team-lead", s.role === "coder", s.accessory)}
				<span class="text-[8px] font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(displayTitle)}</span>
			</button>
		`;
	};

	const renderCollapsedGoalSessions = (goalSessions: GatewaySession[], goal: Goal) => {
		const isTeam = !!(goal as any).team;
		const teamLead = isTeam ? goalSessions.find(s => s.role === "team-lead") : null;
		if (!teamLead) return goalSessions.map(s => renderCollapsedSession(s));

		const children = goalSessions.filter(s => s.id !== teamLead.id);
		const tlExpanded = isTeamLeadExpanded(teamLead.id);
		const tlActive = activeSessionId() === teamLead.id;
		const tlTitle = tlActive && state.remoteAgent ? state.remoteAgent.title : teamLead.title;

		return html`
			<button
				class="flex items-center gap-0.5 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${tlActive ? "bg-secondary" : "hover:bg-secondary/50"}"
				@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, teamLead, tlTitle)}
				@mouseleave=${hideSessionTooltip}
				@click=${() => { if (!tlActive) connectToSession(teamLead.id, true); }}
			>
				<span class="text-[9px] text-muted-foreground shrink-0 select-none" style="width:8px;text-align:center;cursor:pointer;"
					@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(teamLead.id); renderApp(); }}
				>${children.length > 0 ? (tlExpanded ? "▾" : "▸") : ""}</span>
				${statusBobbit(teamLead.status, teamLead.isCompacting, teamLead.id, tlActive, teamLead.isAborting, true, false, teamLead.accessory)}
				<span class="text-[8px] font-bold tracking-wide ${tlActive ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(tlTitle)}</span>
			</button>
			${tlExpanded ? children.map(s => html`<div style="padding-left:6px;">${renderCollapsedSession(s)}</div>`) : ""}
		`;
	};

	return html`
		<div class="w-14 shrink-0 h-full flex flex-col items-center sidebar-edge" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
				${sortedGoals.map((goal, i) => {
					const goalSessions = allSessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf);
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
						${expanded ? renderCollapsedGoalSessions(goalSessions, goal) : ""}
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
