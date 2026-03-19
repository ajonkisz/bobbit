import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { ArrowLeft, Crosshair, Pencil, Plus, QrCode, Server, Trash2, Unplug, Users } from "lucide";
import "../ui/components/WorkflowStatusBar.js";
import { extractWorkflowStatus } from "../ui/components/WorkflowStatusBar.js";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	ungroupedExpanded,
	setUngroupedExpanded,
	type GoalState,
} from "./state.js";
import { createGoal, gatewayFetch, refreshSessions } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { backToSessions, disconnectGateway, createAndConnectSession, connectToSession, terminateSession, saveGoalDraft, deleteGoalDraft } from "./session-manager.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog } from "./dialogs.js";
import { renderSidebar } from "./sidebar.js";

import { renderGoalGroup, renderSessionRow } from "./render-helpers.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

import { cwdCombobox, worktreeToggle } from "./cwd-combobox.js";
import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";
import { renderRoleManagerPage, loadRolePageData } from "./role-manager-page.js";
import "./role-manager.css";

// Expose for testing
(window as any).__extractWorkflowStatus = extractWorkflowStatus;

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */

function renderMobileLanding() {
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.delegateOf);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));
	const isUngroupedExpanded = ungroupedExpanded;

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto">
			<div class="w-full max-w-xl mx-auto px-2 py-4 flex flex-col gap-1">
				<div class="flex items-center gap-1 px-1 pb-2 mb-1 border-b border-border/30">
					<button class="flex-1 text-xs text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); }}>
						${icon(Users, "xs")} Roles
					</button>
					<button class="flex-1 text-xs text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => showGoalDialog()}>
						${icon(Crosshair, "xs")} New Goal
					</button>
				</div>
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
									${renderGoalGroup(goal)}
								`)}
								${sortedGoals.length > 0 ? html`
									<div class="border-t border-border/30 my-1 mx-2"></div>
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
											@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
											<span class="text-xs text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${isUngroupedExpanded ? "▾" : "▸"}</span>
											<span class="flex-1 text-xs text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
											<button
												class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
												@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
												title="New session"
											>${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}</button>
										</div>
										${isUngroupedExpanded ? ungroupedSessions.map(renderSessionRow) : ""}
									</div>
								` : ungroupedSessions.length > 0 ? html`
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 px-2 py-1.5">
											<span class="flex-1 text-xs text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:15px;">Sessions</span>
											<button
												class="p-1 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
												@click=${() => createAndConnectSession()}
												title="New session"
											>${state.creatingSession && !state.creatingSessionForGoalId
												? html`<svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
												: icon(Plus, "xs")}</button>
										</div>
										${ungroupedSessions.map(renderSessionRow)}
									</div>
								` : ""}


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
		const teamMode = state.previewTeamMode;
		const worktree = state.previewWorktree;
		state.previewTeamMode = false;
		state.previewWorktree = false;
		// Clean up persisted draft
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		setHashRoute("landing");
		state.appView = "authenticated";

		await createGoal(trimmedTitle, state.previewCwd.trim(), { spec: state.previewSpec, team: teamMode, worktree });
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
						.checked=${state.previewTeamMode}
						@change=${(e: Event) => { state.previewTeamMode = (e.target as HTMLInputElement).checked; if (state.previewTeamMode) state.previewWorktree = true; const sid = activeSessionId(); if (sid) saveGoalDraft(sid); renderApp(); }}
						class="toggle-switch" />
					<span class="text-xs text-muted-foreground">🐝 Team mode — Team Lead auto-spawns role agents</span>
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
		if (route.view === "roles") {
			return renderRoleManagerPage();
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
				${state.goalAssistantTab === "chat"
					? html`<div class="flex-1 min-h-0 flex flex-col">${state.chatPanel}</div>`
					: html`<div class="flex-1 min-h-0 flex flex-col">${goalPreviewPanel()}</div>`
				}
			`;
		}
		if (connected) return html`${reconnectBanner()}${state.chatPanel}`;

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
					class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border flex flex-col">
					<div class="flex items-center justify-between">
						${headerLeft()}
						${headerRight()}
					</div>
					${workflowBar("mobile")}
					${state.isGoalAssistantSession ? goalAssistantTabBar() : ""}
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
