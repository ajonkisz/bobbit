import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { ArrowLeft, Crosshair, LayoutDashboard, Pencil, Play, Plus, QrCode, Server, Square, Trash2, Unplug } from "lucide";
import "../ui/components/WorkflowStatusBar.js";
import { extractWorkflowStatus } from "../ui/components/WorkflowStatusBar.js";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	expandedGoals,
	saveExpandedGoals,
	ungroupedExpanded,
	setUngroupedExpanded,
	type GoalState,
} from "./state.js";
import { createGoal, gatewayFetch, refreshSessions, startSwarm, teardownSwarm } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { backToSessions, disconnectGateway, createAndConnectSession, connectToSession, terminateSession, saveGoalDraft, deleteGoalDraft } from "./session-manager.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog, showGoalEditDialogFromProposal } from "./dialogs.js";
import { renderSidebar } from "./sidebar.js";

import type { GatewaySession } from "./state.js";
import { statusBobbit } from "./session-colors.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

import { cwdCombobox, worktreeToggle } from "./cwd-combobox.js";
import { mobileHeaderVisible, teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";

// Expose for testing
(window as any).__extractWorkflowStatus = extractWorkflowStatus;

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Track which goals have a swarm start/stop in flight (mobile landing). */
const mobileSwarmLoading = new Set<string>();

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */
function renderMobileSessionRow(session: GatewaySession) {
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	const isActive = session.status === "streaming" || session.status === "busy" || session.isCompacting;
	return html`
		<div
			class="flex items-center gap-1 pl-3 pr-1 py-1 rounded-md cursor-pointer transition-colors
				${active ? "bg-secondary text-foreground" : connecting ? "bg-secondary/30 text-muted-foreground" : "text-muted-foreground active:bg-secondary/50"}"
			@click=${() => { if (!active && !connecting) connectToSession(session.id, true); }}
		>
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder")}
			</div>
			<div class="flex-1 min-w-0 truncate text-xs ${isActive ? "font-semibold" : "font-normal"}">${displayTitle}</div>
			<button class="shrink-0 p-1.5 rounded text-muted-foreground active:bg-secondary/80"
				@click=${(e: Event) => { e.stopPropagation(); showRenameDialog(session.id, displayTitle); }}
				title="Rename">${icon(Pencil, "xs")}</button>
			<button class="shrink-0 p-1.5 rounded text-muted-foreground active:bg-destructive/10"
				@click=${(e: Event) => { e.stopPropagation(); terminateSession(session.id); }}
				title="Terminate">${icon(Trash2, "xs")}</button>
		</div>
	`;
}

function renderMobileGoalCard(goal: { id: string; title: string; cwd: string; state: GoalState; spec: string; swarm?: boolean }) {
	const goalSessions = state.gatewaySessions.filter((s) => s.goalId === goal.id && !s.delegateOf);
	const isSwarmGoal = !!(goal as any).swarm;
	const hasActiveSwarm = isSwarmGoal && goalSessions.some((s) => s.role === "team-lead" && s.status !== "terminated");
	const isLoading = mobileSwarmLoading.has(goal.id);
	const isExpanded = expandedGoals.has(goal.id);
	const activeSessions = goalSessions.filter((s) => s.status === "streaming" || s.status === "busy");

	const toggleExpand = () => {
		if (isExpanded) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id);
		saveExpandedGoals();
		renderApp();
	};

	const handleStartSwarm = async (e: Event) => {
		e.stopPropagation();
		mobileSwarmLoading.add(goal.id);
		renderApp();
		const sid = await startSwarm(goal.id);
		mobileSwarmLoading.delete(goal.id);
		if (sid) {
			connectToSession(sid, false);
		} else {
			renderApp();
		}
	};

	const handleEndSwarm = async (e: Event) => {
		e.stopPropagation();
		mobileSwarmLoading.add(goal.id);
		renderApp();
		await teardownSwarm(goal.id);
		mobileSwarmLoading.delete(goal.id);
		await refreshSessions();
		renderApp();
	};

	return html`
		<div class="flex flex-col ${goal.state === "shelved" ? "opacity-60" : ""}">
			<div class="flex items-center gap-1 px-1 py-1 rounded-md cursor-pointer active:bg-secondary/50 transition-colors" @click=${toggleExpand}>
				<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${isExpanded ? "▾" : "▸"}</span>
				<span class="flex-1 min-w-0 truncate text-[10px] text-muted-foreground uppercase tracking-wider font-medium">${goal.title}</span>
				<button class="shrink-0 p-1.5 rounded text-muted-foreground active:bg-secondary/80"
					@click=${(e: Event) => { e.stopPropagation(); setHashRoute("goal-dashboard", goal.id); }}
					title="Goal dashboard">${icon(LayoutDashboard, "xs")}</button>
			</div>
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5">
					${goalSessions.length === 0
						? html`<div class="pl-3 py-1 text-[10px] text-muted-foreground">
								${isSwarmGoal
									? html`No agents — <button class="text-primary" @click=${handleStartSwarm}>${isLoading ? "starting\u2026" : "start swarm"}</button>`
									: html`No sessions — <button class="text-primary" @click=${() => createAndConnectSession(goal.id)}>start one</button>`}
							</div>`
						: goalSessions.map(renderMobileSessionRow)}
					${goalSessions.length > 0 && isSwarmGoal ? html`
						<div class="pl-3 py-0.5 text-[10px] text-muted-foreground">
							${hasActiveSwarm
								? html`<button class="text-destructive/80" @click=${handleEndSwarm} ?disabled=${isLoading}>${isLoading ? "stopping\u2026" : "end swarm"}</button>`
								: html`<button class="text-primary" @click=${handleStartSwarm} ?disabled=${isLoading}>${isLoading ? "starting\u2026" : "start swarm"}</button>`}
						</div>
					` : ""}
				</div>
			` : ""}
		</div>
	`;
}

function renderMobileLanding() {
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.delegateOf);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));
	const isUngroupedExpanded = ungroupedExpanded;

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto">
			<div class="w-full max-w-xl mx-auto px-2 py-4 flex flex-col gap-1">
				${state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-xs text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground underline" @click=${refreshSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? html`<div class="text-center py-12">
									<div class="text-muted-foreground mb-3 empty-state-icon">${icon(Server, "lg")}</div>
									<p class="text-sm text-muted-foreground mb-4">No goals or sessions yet</p>
									<div class="flex items-center justify-center gap-2">
										${Button({
											variant: "default",
											onClick: () => showGoalDialog(),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(Crosshair, "sm")} Create a Goal</span>`,
										})}
										${Button({
											variant: "ghost",
											disabled: state.creatingSession,
											onClick: () => createAndConnectSession(),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Quick Session</span>`,
										})}
									</div>
								</div>`
							: html`
								${sortedGoals.map((goal, i) => html`
									${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
									${renderMobileGoalCard(goal)}
								`)}
								${sortedGoals.length > 0 && ungroupedSessions.length > 0 ? html`
									<div class="border-t border-border/30 my-1 mx-2"></div>
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
											@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
											<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${isUngroupedExpanded ? "▾" : "▸"}</span>
											<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
											<button
												class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
												@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
												title="New session"
											>${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}</button>
										</div>
										${isUngroupedExpanded ? ungroupedSessions.map(renderMobileSessionRow) : ""}
									</div>
								` : sortedGoals.length === 0 && ungroupedSessions.length > 0 ? html`
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 px-2 py-1.5">
											<span class="flex-1 text-[10px] text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:15px;">Sessions</span>
											<button
												class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
												@click=${() => createAndConnectSession()}
												title="New session"
											>${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}</button>
										</div>
										${ungroupedSessions.map(renderMobileSessionRow)}
									</div>
								` : ""}

								<div class="flex items-center gap-1 px-2 pt-2">
									<button class="text-[10px] text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center gap-1"
										@click=${() => showGoalDialog()}>
										${icon(Crosshair, "xs")} New Goal
									</button>
								</div>
							`}
			</div>
		</div>
	`;
}

// ============================================================================
// GOAL PREVIEW PANEL (goal assistant split-screen)
// ============================================================================

function goalPreviewPanel() {
	const handleCreateGoal = async () => {
		const trimmedTitle = state.previewTitle.trim();
		if (!trimmedTitle) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.isGoalAssistantSession = false;
		state.activeGoalProposal = null;
		const swarmMode = state.previewSwarmMode;
		const worktree = state.previewWorktree;
		state.previewSwarmMode = false;
		state.previewWorktree = false;
		// Clean up persisted draft
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		setHashRoute("landing");
		state.appView = "authenticated";

		await createGoal(trimmedTitle, state.previewCwd.trim(), { spec: state.previewSpec, swarm: swarmMode, worktree });
		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();
		renderApp();
	};

	const handleCancel = () => {
		backToSessions();
	};

	if (!state.hasReceivedProposal) {
		return html`
			<div class="goal-preview-panel flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center border-l border-border">
				<div class="text-muted-foreground empty-state-icon">${icon(Crosshair, "lg")}</div>
				<p class="text-sm text-muted-foreground max-w-[280px]">
					Chat with the assistant to define your goal. The proposal will appear here as it takes shape.
				</p>
				<div class="mt-2">
					${Button({ variant: "ghost", size: "sm", onClick: handleCancel, children: "Cancel" })}
				</div>
			</div>
		`;
	}

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Title</label>
					${Input({
						type: "text",
						value: state.previewTitle,
						placeholder: "Goal title",
						onInput: (e: Event) => {
							state.previewTitle = (e.target as HTMLInputElement).value;
							state.previewTitleEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
					${cwdCombobox({
						value: state.previewCwd,
						placeholder: "(server default)",
						onInput: (v) => {
							state.previewCwd = v;
							state.previewCwdEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
							renderApp();
						},
						onSelect: (v) => {
							state.previewCwd = v;
							state.previewCwdEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
							renderApp();
						},
						dropdownOpen: state.cwdDropdownOpen,
						onToggle: (open) => { state.cwdDropdownOpen = open; renderApp(); },
						highlightedIndex: state.cwdHighlightIndex,
						onHighlight: (i) => { state.cwdHighlightIndex = i; renderApp(); },
					})}
					<div class="mt-2">${worktreeToggle({
						checked: state.previewWorktree,
						onChange: (v) => { state.previewWorktree = v; const sid = activeSessionId(); if (sid) saveGoalDraft(sid); renderApp(); },
					})}</div>
				</div>
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Spec</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							@click=${() => { state.previewSpecEditMode = !state.previewSpecEditMode; renderApp(); }}
						>
							${state.previewSpecEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.previewSpecEditMode
						? html`<textarea
								class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.previewSpec}
								@input=${(e: Event) => {
									state.previewSpec = (e.target as HTMLTextAreaElement).value;
									state.previewSpecEdited = true;
									const sid = activeSessionId();
									if (sid) saveGoalDraft(sid);
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.previewSpec || "_No spec content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
				<label class="flex items-center gap-2.5 cursor-pointer">
					<input type="checkbox"
						.checked=${state.previewSwarmMode}
						@change=${(e: Event) => { state.previewSwarmMode = (e.target as HTMLInputElement).checked; if (state.previewSwarmMode) state.previewWorktree = true; const sid = activeSessionId(); if (sid) saveGoalDraft(sid); renderApp(); }}
						class="toggle-switch" />
					<span class="text-xs text-muted-foreground">🐝 Swarm mode — Team Lead auto-spawns role agents</span>
				</label>
				<div class="flex items-center justify-end gap-2">
					${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
					${Button({
						variant: "default",
						onClick: handleCreateGoal,
						disabled: !state.previewTitle.trim(),
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Crosshair, "sm")} Create Goal</span>`,
					})}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER APP
// ============================================================================

export function doRenderApp(): void {
	const app = document.getElementById("app");
	if (!app) return;

	document.documentElement.style.setProperty("--bobbit-shimmer-delay", `${-(Date.now() % 8000)}ms`);

	// Disconnected state
	if (state.appView === "disconnected") {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="inline-flex items-center gap-1">${icon(Server, "sm")} <span class="text-xs">Connect</span></span>`,
							onClick: openGatewayDialog,
							title: "Connect to gateway",
						})}
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
					<div class="flex flex-col items-center gap-3 text-center">
						<div class="text-muted-foreground empty-state-icon">${icon(Unplug, "lg")}</div>
						<h2 class="text-lg font-medium text-foreground">Not connected</h2>
						<p class="text-sm text-muted-foreground max-w-sm">
							Connect to a Pi Gateway to start working with the coding agent.
						</p>
					</div>
					${Button({
						variant: "default",
						onClick: openGatewayDialog,
						children: html`<span class="inline-flex items-center gap-2">${icon(Server, "sm")} Connect to Gateway</span>`,
					})}
				</div>
			</div>
		`, app);
		return;
	}

	// Authenticated state
	const desktop = isDesktop();
	const connected = hasActiveSession();

	const headerLeft = () => {
		if (connected && state.remoteAgent) {
			const model = state.remoteAgent.state.model;

			const backBtn = !desktop ? Button({
				variant: "ghost",
				size: "sm",
				children: html`<span class="inline-flex items-center gap-1.5">${icon(ArrowLeft, "sm")} <span class="text-xs">All Sessions</span></span>`,
				onClick: backToSessions,
				title: "Back to session list",
				className: "h-10 pl-3 pr-3",
			}) : "";

			const sessionTitle = state.remoteAgent.title || "New session";
			const sid = activeSessionId();
			const editDeleteBtns = sid ? html`
				<div class="flex items-center shrink-0">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => showRenameDialog(sid, sessionTitle),
						children: icon(Pencil, "xs"),
						className: "h-7 w-7 text-muted-foreground",
						title: "Rename session",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => terminateSession(sid),
						children: icon(Trash2, "xs"),
						className: "h-7 w-7 text-muted-foreground hover:text-destructive",
						title: "Terminate session",
					})}
				</div>
			` : "";

			if (!desktop) {
				return html`
					<div class="flex items-center w-full pr-2 relative" style="min-height:40px;">
						<div class="shrink-0">${backBtn}</div>
						<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
							<span class="text-sm font-medium text-foreground truncate px-16" title=${sessionTitle}>${sessionTitle}</span>
						</div>
						<div class="ml-auto shrink-0">${editDeleteBtns}</div>
					</div>
				`;
			}
			return html`
				<div class="flex items-center gap-2 px-3">
					<span class="text-sm font-medium text-foreground truncate max-w-[320px] py-2" title=${sessionTitle}>${sessionTitle}</span>
					${editDeleteBtns}
				</div>
			`;
		}

		if (!desktop) {
			return html`<div class="flex items-center gap-2 px-4 py-1">
				${bobbitIcon}
				<span class="text-base font-semibold text-foreground">Bobbit</span>
			</div>`;
		}
		return html`<div></div>`;
	};

	const headerRight = () => {
		if (desktop) {
			return html`
				<div class="flex items-center gap-1 px-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: html`${icon(Unplug, "sm")}`,
						onClick: disconnectGateway,
						title: "Disconnect from gateway",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: html`${icon(QrCode, "sm")}`,
						onClick: showQrCodeDialog,
						title: "Show QR code",
					})}
					<theme-toggle></theme-toggle>
				</div>
			`;
		}
		if (connected && state.remoteAgent) {
			return html``;
		}
		return html`
			<div class="flex items-center gap-1 px-2">
				${Button({
					variant: "ghost",
					size: "sm",
					children: html`${icon(QrCode, "sm")}`,
					onClick: showQrCodeDialog,
					title: "Show QR code",
				})}
				${Button({
					variant: "ghost",
					size: "sm",
					children: html`${icon(Unplug, "sm")}`,
					onClick: disconnectGateway,
					title: "Disconnect from gateway",
				})}
				<theme-toggle></theme-toggle>
			</div>
		`;
	};

	const reconnectBanner = () => {
		if (!connected || state.connectionStatus === "connected") return "";
		return html`
			<div class="reconnect-banner shrink-0 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium
				${state.connectionStatus === "reconnecting"
					? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
					: "bg-red-500/15 text-red-700 dark:text-red-400"}">
				${state.connectionStatus === "reconnecting"
					? html`
						<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
						</svg>
						<span>Reconnecting to server…</span>`
					: html`<span>Disconnected from server</span>`}
			</div>
		`;
	};

	const goalProposalBanner = () => {
		if (state.isGoalAssistantSession) return "";
		if (!state.activeGoalProposal || !connected) return "";
		const p = state.activeGoalProposal;
		return html`
			<div class="shrink-0 border-b border-border bg-primary/5 px-4 py-3">
				<div class="flex items-start gap-3">
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 mb-1">
							<span class="text-xs font-medium text-primary uppercase tracking-wider">Goal Proposal</span>
						</div>
						<div class="text-sm font-medium text-foreground">${p.title}</div>
						${p.cwd ? html`<div class="text-xs text-muted-foreground font-mono mt-0.5">${p.cwd}</div>` : ""}
						<div class="text-xs text-muted-foreground mt-1 line-clamp-2">${p.spec.slice(0, 200)}${p.spec.length > 200 ? "…" : ""}</div>
					</div>
					<div class="flex items-center gap-1.5 shrink-0">
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => { showGoalEditDialogFromProposal(p); },
							children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "sm")} Edit</span>`,
						})}
						${Button({
							variant: "default",
							size: "sm",
							onClick: async () => {
								const sessionId = activeSessionId();
								await createGoal(p.title, p.cwd || "", { spec: p.spec });
								state.activeGoalProposal = null;
								if (sessionId) {
									await terminateSession(sessionId);
								}
							},
							children: html`<span class="inline-flex items-center gap-1">${icon(Crosshair, "sm")} Create Goal</span>`,
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => { state.activeGoalProposal = null; renderApp(); },
							children: "Dismiss",
						})}
					</div>
				</div>
			</div>
		`;
	};

	const goalAssistantTabBar = () => {
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.goalAssistantTab === "chat" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.goalAssistantTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${state.goalAssistantTab === "preview" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.goalAssistantTab = "preview"; renderApp(); }}
				>
					Preview${state.hasReceivedProposal ? html` <span class="goal-tab-dot"></span>` : ""}
				</button>
			</div>
		`;
	};

	const workflowBar = (position: "desktop" | "mobile" = "desktop") => {
		if (!state.remoteAgent) return html``;
		const wfStatus = extractWorkflowStatus(
			state.remoteAgent.state.messages,
			activeSessionId(),
			state.remoteAgent.state.streamMessage,
			state.remoteAgent.state.toolPartialResults,
		);
		if (!wfStatus) return html``;
		const borderClass = position === "desktop"
			? "border-b border-border bg-card/80 backdrop-blur-sm"
			: "border-t border-border";
		return html`<div class="${borderClass}"><workflow-status-bar .status=${wfStatus}></workflow-status-bar></div>`;
	};

	const mainArea = () => {
		// Goal dashboard route
		const route = getRouteFromHash();
		if (route.view === "goal-dashboard" && route.goalId) {
			return renderGoalDashboard();
		}

		if (connected && state.isGoalAssistantSession) {
			if (desktop) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0 overflow-hidden">
						<div class="goal-chat-panel flex-1 min-w-0 flex flex-col">${state.chatPanel}</div>
						${goalPreviewPanel()}
					</div>
				`;
			}
			return html`
				${reconnectBanner()}
				${goalAssistantTabBar()}
				${state.goalAssistantTab === "chat"
					? html`<div class="flex-1 min-h-0 flex flex-col">${state.chatPanel}</div>`
					: html`<div class="flex-1 min-h-0 flex flex-col">${goalPreviewPanel()}</div>`
				}
			`;
		}
		if (connected) return html`${reconnectBanner()}${goalProposalBanner()}${state.chatPanel}`;

		if (desktop) {
			return html`
				<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
					<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
					<p class="text-sm text-muted-foreground">Select a session from the sidebar or create a new one</p>
					${Button({
						variant: "default",
						size: "sm",
						disabled: state.creatingSession,
						onClick: () => createAndConnectSession(),
						children: state.creatingSession
							? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
							: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} New Session</span>`,
					})}
				</div>
			`;
		}
		return renderMobileLanding();
	};

	if (desktop) {
		teardownMobileScrollTracking();
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center border-b border-border shrink-0">
					${state.sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center self-stretch" style="background: var(--sidebar);">
						${bobbitIcon}
					</div>
					` : html`
					<div class="w-[240px] shrink-0 flex items-center justify-between px-3 self-stretch" style="background: var(--sidebar);">
						<div class="flex items-center gap-2">
							${bobbitIcon}
							<span class="text-base font-semibold text-foreground">Bobbit</span>
						</div>
						<div class="flex items-center gap-0.5">
							<button
								class="inline-flex items-center gap-1 p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
								@click=${() => showGoalDialog()}
								title="New goal"
							>
								${icon(Crosshair, "sm")}
								<span class="text-xs">New Goal</span>
							</button>
						</div>
					</div>
					`}
					<div class="flex-1 flex items-center justify-between min-w-0">
						${headerLeft()}
						${headerRight()}
					</div>
				</div>
				<div class="flex-1 flex min-h-0">
					${renderSidebar()}
					<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">
						${workflowBar()}
						${mainArea()}
					</div>
				</div>
			</div>
		`, app);
	} else if (connected) {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden relative"
				data-mobile-header>
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border flex flex-col"
					style="transform: translateY(${mobileHeaderVisible ? "0" : "-100%"}); transition: transform 200ms ease, box-shadow 200ms ease; will-change: transform;">
					<div class="flex items-center justify-between">
						${headerLeft()}
						${headerRight()}
					</div>
					${workflowBar("mobile")}
				</div>
				<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
		ensureMobileScrollTracking();
		requestAnimationFrame(() => {
			const headerEl = document.getElementById("app-header");
			if (headerEl) {
				const h = headerEl.offsetHeight;
				document.documentElement.style.setProperty("--mobile-header-height", `${h + 16}px`);
			}
		});
	} else {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					${headerLeft()}
					${headerRight()}
				</div>
				<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
	}
}
