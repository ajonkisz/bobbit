import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { ArrowLeft, ChevronDown, ChevronRight, Crosshair, Layers, PanelRightClose, PanelRightOpen, Pencil, Plus, QrCode, Server, Sparkles, Trash2, Unplug, Users, Wrench } from "lucide";
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
import { createGoal, createRole, gatewayFetch, refreshSessions } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { backToSessions, disconnectGateway, createAndConnectSession, connectToSession, terminateSession, saveGoalDraft, deleteGoalDraft, saveRoleDraft, deleteRoleDraft } from "./session-manager.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog } from "./dialogs.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown } from "./sidebar.js";

import { renderGoalGroup, renderSessionRow } from "./render-helpers.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

import { cwdCombobox, worktreeToggle } from "./cwd-combobox.js";

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";
import { renderRoleManagerPage, loadRolePageData } from "./role-manager-page.js";
import "./role-manager.css";
import { renderToolManagerPage } from "./tool-manager-page.js";
import "./tool-manager.css";
import { renderArtifactSpecPage } from "./artifact-spec-page.js";
import "./artifact-spec.css";
import { renderPersonalityManagerPage } from "./personality-manager-page.js";
import "./personality-manager.css";

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
					<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); }}>
						${icon(Users, "xs")} Roles
					</button>
					<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); }}>
						${icon(Wrench, "xs")} Tools
					</button>
					<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => { import("./artifact-spec-page.js").then((m) => m.loadArtifactSpecPageData()); setHashRoute("artifact-specs"); }}>
						${icon(Layers, "xs")} Specs
					</button>
					<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => { import("./personality-manager-page.js").then((m) => m.loadPersonalityPageData()); setHashRoute("personalities"); }}>
						${icon(Sparkles, "xs")} Personalities
					</button>
					<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
						@click=${() => showGoalDialog()}>
						${icon(Crosshair, "xs")} Goal
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
									<p class="text-base text-muted-foreground mb-4">No goals or sessions yet</p>
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
											<span class="text-sm text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${isUngroupedExpanded ? "▾" : "▸"}</span>
											<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
											<div class="flex items-center relative">
												<button
													class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
													@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
													title="New session"
												>${state.creatingSession && !state.creatingSessionForGoalId
													? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
													: icon(Plus, "sm")}</button>
												<button
													class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
													@click=${toggleRolePicker}
													title="New session with role"
												>${icon(ChevronDown, "sm")}</button>
												${renderRolePickerDropdown()}
											</div>
										</div>
										${isUngroupedExpanded ? ungroupedSessions.map(renderSessionRow) : ""}
									</div>
								` : ungroupedSessions.length > 0 ? html`
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 px-2 py-1.5">
											<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium" style="padding-left:15px;">Sessions</span>
											<div class="flex items-center relative">
												<button
													class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
													@click=${() => createAndConnectSession()}
													title="New session"
												>${state.creatingSession && !state.creatingSessionForGoalId
													? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
													: icon(Plus, "sm")}</button>
												<button
													class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
													@click=${toggleRolePicker}
													title="New session with role"
												>${icon(ChevronDown, "sm")}</button>
												${renderRolePickerDropdown()}
											</div>
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
		state.assistantType = null;
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
// ROLE PREVIEW PANEL (role assistant split-screen)
// ============================================================================

import { ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { fetchTools, type ToolInfo } from "./api.js";

/** Cached available tools list (loaded once). */
let _availableTools: ToolInfo[] = [];
let _toolsLoaded = false;

function ensureToolsLoaded(): void {
	if (_toolsLoaded) return;
	_toolsLoaded = true;
	fetchTools().then((result) => { _availableTools = result.tools; renderApp(); });
}

function rolePreviewPanel() {
	ensureToolsLoaded();

	const handleCreateRole = async () => {
		const trimmedName = state.rolePreviewName.trim();
		const trimmedLabel = state.rolePreviewLabel.trim();
		if (!trimmedName || !trimmedLabel) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		state.activeRoleProposal = null;
		// Clean up persisted draft
		if (sessionId) {
			deleteRoleDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");

		// Parse tools: comma-separated string -> array
		const toolsList = state.rolePreviewTools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		await createRole({
			name: trimmedName,
			label: trimmedLabel,
			promptTemplate: state.rolePreviewPrompt,
			allowedTools: toolsList,
			accessory: state.rolePreviewAccessory,
		});

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}

		// Navigate to the roles page
		const { loadRolePageData } = await import("./role-manager-page.js");
		await loadRolePageData();
		setHashRoute("roles");
		renderApp();
	};

	const handleCancel = () => {
		backToSessions();
	};

	// Parse current tools string into array for display
	const currentTools = state.rolePreviewTools
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: state.rolePreviewName,
						placeholder: "role-name (lowercase, hyphens)",
						onInput: (e: Event) => {
							state.rolePreviewName = (e.target as HTMLInputElement).value;
							state.rolePreviewNameEdited = true;
							const sid = activeSessionId();
							if (sid) saveRoleDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Label</label>
					${Input({
						type: "text",
						value: state.rolePreviewLabel,
						placeholder: "Display Label",
						onInput: (e: Event) => {
							state.rolePreviewLabel = (e.target as HTMLInputElement).value;
							state.rolePreviewLabelEdited = true;
							const sid = activeSessionId();
							if (sid) saveRoleDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Accessory</label>
					<div class="flex flex-wrap gap-2">
						${ACCESSORY_IDS.map((accId) => {
							const acc = getAccessory(accId);
							const isSelected = state.rolePreviewAccessory === accId;
							return html`
								<button
									class="flex flex-col items-center gap-1 px-2 py-1.5 rounded border transition-colors ${isSelected ? "border-primary bg-primary/10" : "border-border hover:border-muted-foreground/50"}"
									@click=${() => {
										state.rolePreviewAccessory = accId;
										state.rolePreviewAccessoryEdited = true;
										const sid = activeSessionId();
										if (sid) saveRoleDraft(sid);
										renderApp();
									}}
									title=${acc.label}
								>
									${statusBobbit("idle", false, undefined, isSelected, false, accId === "crown", accId === "bandana", accId)}
									<span class="text-[10px] text-muted-foreground">${acc.label}</span>
								</button>
							`;
						})}
					</div>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Tools</label>
					<div class="flex flex-wrap gap-1 mb-2">
						${currentTools.map((tool) => html`
							<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
								${tool}
								<button class="hover:text-destructive" @click=${() => {
									const remaining = currentTools.filter((t) => t !== tool);
									state.rolePreviewTools = remaining.join(", ");
									state.rolePreviewToolsEdited = true;
									const sid = activeSessionId();
									if (sid) saveRoleDraft(sid);
									renderApp();
								}}>&times;</button>
							</span>
						`)}
						${currentTools.length === 0 ? html`<span class="text-xs text-muted-foreground italic">All tools allowed</span>` : ""}
					</div>
					${_availableTools.length > 0 ? html`
						<div class="flex flex-wrap gap-1">
							${_availableTools.filter((t) => !currentTools.includes(t.name)).map((tool) => html`
								<button
									class="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
									title="${tool.description}"
									@click=${() => {
										const newTools = [...currentTools, tool.name];
										state.rolePreviewTools = newTools.join(", ");
										state.rolePreviewToolsEdited = true;
										const sid = activeSessionId();
										if (sid) saveRoleDraft(sid);
										renderApp();
									}}
								>+ ${tool.name}</button>
							`)}
						</div>
					` : ""}
				</div>
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							@click=${() => { state.rolePreviewPromptEditMode = !state.rolePreviewPromptEditMode; renderApp(); }}
						>
							${state.rolePreviewPromptEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.rolePreviewPromptEditMode
						? html`<textarea
								class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.rolePreviewPrompt}
								@input=${(e: Event) => {
									state.rolePreviewPrompt = (e.target as HTMLTextAreaElement).value;
									state.rolePreviewPromptEdited = true;
									const sid = activeSessionId();
									if (sid) saveRoleDraft(sid);
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.rolePreviewPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
				${Button({
					variant: "default",
					onClick: handleCreateRole,
					disabled: !state.rolePreviewName.trim() || !state.rolePreviewLabel.trim(),
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Users, "sm")} Create Role</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// TOOL PREVIEW PANEL (tool assistant split-screen)
// ============================================================================

function toolPreviewPanel() {
	const handleDone = () => {
		backToSessions();
	};

	const handleViewTool = async () => {
		const toolName = state.toolPreviewName.trim();
		if (!toolName) return;
		const { loadToolPageData } = await import("./tool-manager-page.js");
		await loadToolPageData();
		setHashRoute("tool-edit", toolName);
		renderApp();
	};

	const checklist = state.toolPreviewChecklist;
	const checklistItems = [
		{ key: "docs" as const, label: "Documentation", desc: "Usage examples, parameter descriptions" },
		{ key: "renderer" as const, label: "Renderer", desc: "Custom tool call display component" },
		{ key: "tests" as const, label: "Tests", desc: "Unit and E2E test coverage" },
		{ key: "config" as const, label: "Configuration", desc: "Tool metadata, groups, role access" },
	];

	const statusIcon = (s: "pending" | "in-progress" | "done") =>
		s === "done" ? html`<span class="text-green-500">&#10003;</span>`
		: s === "in-progress" ? html`<span class="text-yellow-500 animate-pulse">&#9679;</span>`
		: html`<span class="text-muted-foreground">&#9675;</span>`;

	const doneCount = Object.values(checklist).filter((s) => s === "done").length;
	const total = checklistItems.length;

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<!-- Tool name header -->
				<div>
					<div class="text-xs text-muted-foreground mb-1">Tool</div>
					<div class="text-lg font-semibold">${state.toolPreviewName || html`<span class="text-muted-foreground italic">Waiting for assistant...</span>`}</div>
				</div>

				<!-- Progress bar -->
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<span class="text-xs text-muted-foreground font-medium">Progress</span>
						<span class="text-xs text-muted-foreground">${doneCount}/${total}</span>
					</div>
					<div class="h-1.5 rounded-full bg-secondary overflow-hidden">
						<div class="h-full rounded-full bg-primary transition-all duration-500" style="width: ${(doneCount / total) * 100}%"></div>
					</div>
				</div>

				<!-- Checklist -->
				<div class="flex flex-col gap-2">
					${checklistItems.map((item) => html`
						<div class="flex items-start gap-2.5 p-2.5 rounded-md border border-border ${checklist[item.key] === "done" ? "bg-green-500/5" : ""}">
							<div class="mt-0.5 text-sm">${statusIcon(checklist[item.key])}</div>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium">${item.label}</div>
								<div class="text-xs text-muted-foreground">${item.desc}</div>
							</div>
						</div>
					`)}
				</div>

				<!-- Documentation preview -->
				${state.toolPreviewDocs ? html`
					<div>
						<div class="text-xs text-muted-foreground mb-1.5 font-medium">Documentation Preview</div>
						<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[200px]">
							<markdown-block .content=${state.toolPreviewDocs}></markdown-block>
						</div>
					</div>
				` : ""}

				<!-- Renderer preview -->
				${state.toolPreviewRendererHtml ? html`
					<div>
						<div class="text-xs text-muted-foreground mb-1.5 font-medium">Renderer Preview</div>
						<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[300px]">
							<markdown-block .content=${state.toolPreviewRendererHtml}></markdown-block>
						</div>
					</div>
				` : ""}
			</div>

			<!-- Footer -->
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({ variant: "ghost", onClick: handleDone, children: "Close" })}
				${state.toolPreviewName ? Button({
					variant: "default",
					onClick: handleViewTool,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Wrench, "sm")} View Tool</span>`,
				}) : ""}
			</div>
		</div>
	`;
}

function artifactSpecPreviewPanel() {
	const handleCreateSpec = async () => {
		const id = state.specPreviewId.trim();
		const name = state.specPreviewName.trim();
		if (!id || !name) return;

		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		state.activeArtifactSpecProposal = null;
		localStorage.removeItem("gateway.sessionId");
		setHashRoute("landing");
		state.appView = "authenticated";

		const { createArtifactSpec } = await import("./api.js");
		await createArtifactSpec({
			id,
			name,
			description: state.specPreviewDescription,
			kind: state.specPreviewKind as any,
			format: state.specPreviewFormat as any,
			mustHave: state.specPreviewMustHave.split("\n").map((s) => s.replace(/^-\s*/, "").trim()).filter(Boolean),
			shouldHave: state.specPreviewShouldHave.split("\n").map((s) => s.replace(/^-\s*/, "").trim()).filter(Boolean),
			mustNotHave: state.specPreviewMustNotHave.split("\n").map((s) => s.replace(/^-\s*/, "").trim()).filter(Boolean),
			requires: state.specPreviewRequires.split(",").map((s) => s.trim()).filter(Boolean),
			suggestedRole: state.specPreviewSuggestedRole || undefined,
		});

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();

		const { loadArtifactSpecPageData } = await import("./artifact-spec-page.js");
		await loadArtifactSpecPageData();
		setHashRoute("artifact-specs");
		renderApp();
	};

	const field = (label: string, stateKey: string, editedKey: string, type: "input" | "textarea" | "select" = "input", options?: { value: string; label: string }[]) => {
		const value = (state as any)[stateKey];
		const onInput = (e: Event) => {
			(state as any)[stateKey] = (e.target as HTMLInputElement).value;
			(state as any)[editedKey] = true;
			renderApp();
		};
		if (type === "select" && options) {
			return html`
				<div>
					<div class="text-xs text-muted-foreground mb-1">${label}</div>
					<select class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background" .value=${value} @change=${onInput}>
						${options.map((o) => html`<option value=${o.value} ?selected=${value === o.value}>${o.label}</option>`)}
					</select>
				</div>
			`;
		}
		if (type === "textarea") {
			return html`
				<div>
					<div class="text-xs text-muted-foreground mb-1">${label}</div>
					<textarea class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background resize-y" rows="3" .value=${value} @input=${onInput}></textarea>
				</div>
			`;
		}
		return html`
			<div>
				<div class="text-xs text-muted-foreground mb-1">${label}</div>
				<input class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background" .value=${value} @input=${onInput} />
			</div>
		`;
	};

	const canCreate = state.specPreviewId.trim() && state.specPreviewName.trim();

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
				<div class="text-sm font-semibold mb-1">Artifact Spec Preview</div>
				${!state.assistantHasProposal ? html`<div class="text-sm text-muted-foreground italic">Waiting for assistant to propose a spec...</div>` : ""}
				${field("ID", "specPreviewId", "specPreviewIdEdited")}
				${field("Name", "specPreviewName", "specPreviewNameEdited")}
				${field("Description", "specPreviewDescription", "specPreviewDescriptionEdited", "textarea")}
				${field("Kind", "specPreviewKind", "specPreviewKindEdited", "select", [
					{ value: "analysis", label: "Analysis" },
					{ value: "deliverable", label: "Deliverable" },
					{ value: "review", label: "Review" },
					{ value: "verification", label: "Verification" },
				])}
				${field("Format", "specPreviewFormat", "specPreviewFormatEdited", "select", [
					{ value: "markdown", label: "Markdown" },
					{ value: "html", label: "HTML" },
					{ value: "diff", label: "Diff" },
					{ value: "command", label: "Command" },
				])}
				${field("Must Have (one per line)", "specPreviewMustHave", "specPreviewMustHaveEdited", "textarea")}
				${field("Should Have (one per line)", "specPreviewShouldHave", "specPreviewShouldHaveEdited", "textarea")}
				${field("Must Not Have (one per line)", "specPreviewMustNotHave", "specPreviewMustNotHaveEdited", "textarea")}
				${field("Requires (comma-separated spec IDs)", "specPreviewRequires", "specPreviewRequiresEdited")}
				${field("Suggested Role", "specPreviewSuggestedRole", "specPreviewSuggestedRoleEdited")}
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({ variant: "ghost", onClick: backToSessions, children: "Close" })}
				${canCreate ? Button({
					variant: "default",
					onClick: handleCreateSpec,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Layers, "sm")} Create Spec</span>`,
				}) : ""}
			</div>
		</div>
	`;
}

// ============================================================================
// ASSISTANT PREVIEW DISPATCH
// ============================================================================

function personalityPreviewPanel() {
	const handleCreatePersonality = async () => {
		const trimmedName = state.personalityPreviewName.trim();
		const trimmedLabel = state.personalityPreviewLabel.trim();
		if (!trimmedName || !trimmedLabel) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		state.activePersonalityProposal = null;
		if (sessionId) {
			const { deletePersonalityDraft } = await import("./session-manager.js");
			deletePersonalityDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");

		const { createPersonality } = await import("./api.js");
		await createPersonality({
			name: trimmedName,
			label: trimmedLabel,
			description: state.personalityPreviewDescription,
			promptFragment: state.personalityPreviewPromptFragment,
		});

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}

		const { loadPersonalityPageData } = await import("./personality-manager-page.js");
		await loadPersonalityPageData();
		setHashRoute("personalities");
		renderApp();
	};

	const handleCancel = () => {
		backToSessions();
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: state.personalityPreviewName,
						placeholder: "personality-name (lowercase, hyphens)",
						onInput: (e: Event) => {
							state.personalityPreviewName = (e.target as HTMLInputElement).value;
							state.personalityPreviewNameEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Label</label>
					${Input({
						type: "text",
						value: state.personalityPreviewLabel,
						placeholder: "Display Label",
						onInput: (e: Event) => {
							state.personalityPreviewLabel = (e.target as HTMLInputElement).value;
							state.personalityPreviewLabelEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					${Input({
						type: "text",
						value: state.personalityPreviewDescription,
						placeholder: "One-line tooltip description",
						onInput: (e: Event) => {
							state.personalityPreviewDescription = (e.target as HTMLInputElement).value;
							state.personalityPreviewDescriptionEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Prompt Fragment</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							@click=${() => { state.personalityPreviewPromptFragmentEditMode = !state.personalityPreviewPromptFragmentEditMode; renderApp(); }}
						>
							${state.personalityPreviewPromptFragmentEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.personalityPreviewPromptFragmentEditMode
						? html`<textarea
								class="flex-1 min-h-[120px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.personalityPreviewPromptFragment}
								@input=${(e: Event) => {
									state.personalityPreviewPromptFragment = (e.target as HTMLTextAreaElement).value;
									state.personalityPreviewPromptFragmentEdited = true;
									const sid = activeSessionId();
									if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[120px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.personalityPreviewPromptFragment || "_No prompt fragment yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
				${Button({
					variant: "default",
					onClick: handleCreatePersonality,
					disabled: !state.personalityPreviewName.trim() || !state.personalityPreviewLabel.trim(),
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Sparkles, "sm")} Create Personality</span>`,
				})}
			</div>
		</div>
	`;
}

function getAssistantPreviewPanel(type: string) {
	switch (type) {
		case "goal": return goalPreviewPanel();
		case "role": return rolePreviewPanel();
		case "tool": return toolPreviewPanel();
		case "artifact-spec": return artifactSpecPreviewPanel();
		case "personality": return personalityPreviewPanel();
		default: return "";
	}
}

// ============================================================================
// PREVIEW SWIPE (mobile)
// ============================================================================

/** Script injected into the preview iframe srcdoc to detect rightward swipes
 *  and send position updates to the parent via postMessage.
 *  Only rightward swipes are captured; all other gestures pass through normally. */
const PREVIEW_SWIPE_SCRIPT = `<script>
(function() {
	var startX = 0, startY = 0, captured = false, decided = false;
	document.addEventListener('touchstart', function(e) {
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, {passive: true});
	document.addEventListener('touchmove', function(e) {
		if (decided && !captured) return;
		var dx = e.touches[0].clientX - startX;
		var dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			captured = dx > 0 && Math.abs(dx) > Math.abs(dy);
			if (captured) parent.postMessage({type:'preview-swipe-start'}, '*');
		}
		if (captured) {
			e.preventDefault();
			parent.postMessage({type:'preview-swipe-move', dx: dx}, '*');
		}
	}, {passive: false});
	document.addEventListener('touchend', function(e) {
		if (!captured) return;
		var dx = e.changedTouches[0].clientX - startX;
		parent.postMessage({type:'preview-swipe-end', dx: dx}, '*');
		captured = false;
		decided = false;
	}, {passive: true});
})();
<\/script>`;

/** Listen for postMessage from the preview iframe and drive the slider track.
 *  Also handles leftward swipes on the chat side (#app touch events). */
function setupPreviewSwipe(): void {
	if ((window as any).__previewSwipeListening) return;
	(window as any).__previewSwipeListening = true;

	// === iframe → parent: rightward swipe on preview ===
	window.addEventListener("message", (e: MessageEvent) => {
		if (!state.isPreviewSession || state.previewPanelTab !== "preview") return;
		const track = document.querySelector(".preview-slider__track") as HTMLElement | null;
		if (!track) return;

		if (e.data?.type === "preview-swipe-start") {
			track.style.transition = "none";
		} else if (e.data?.type === "preview-swipe-move") {
			const dx: number = e.data.dx;
			const dragPercent = (dx / track.parentElement!.clientWidth) * 50;
			track.style.transform = `translateX(${Math.max(-50, Math.min(0, -50 + dragPercent))}%)`;
		} else if (e.data?.type === "preview-swipe-end") {
			track.style.transition = "transform 0.3s ease-out";
			const dx: number = e.data.dx;
			const threshold = track.parentElement!.clientWidth * 0.2;
			if (dx > threshold) {
				state.previewPanelTab = "chat";
			}
			track.style.transform = `translateX(${state.previewPanelTab === "chat" ? 0 : -50}%)`;
			renderApp();
		}
	});

	// === chat side: leftward swipe to show preview ===
	let chatStartX = 0, chatStartY = 0, chatCaptured = false, chatDecided = false;
	const el = document.getElementById("app")!;

	el.addEventListener("touchstart", (e: TouchEvent) => {
		if (!state.isPreviewSession || state.previewPanelTab !== "chat") return;
		chatStartX = e.touches[0].clientX;
		chatStartY = e.touches[0].clientY;
		chatCaptured = false;
		chatDecided = false;
	}, { passive: true });

	el.addEventListener("touchmove", (e: TouchEvent) => {
		if (!state.isPreviewSession || state.previewPanelTab !== "chat") return;
		if (chatDecided && !chatCaptured) return;
		const dx = e.touches[0].clientX - chatStartX;
		const dy = e.touches[0].clientY - chatStartY;
		if (!chatDecided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			chatDecided = true;
			chatCaptured = dx < 0 && Math.abs(dx) > Math.abs(dy); // leftward
			if (chatCaptured) {
				const track = document.querySelector(".preview-slider__track") as HTMLElement | null;
				if (track) track.style.transition = "none";
			}
		}
		if (chatCaptured) {
			const track = document.querySelector(".preview-slider__track") as HTMLElement | null;
			if (track) {
				const dragPercent = (dx / track.parentElement!.clientWidth) * 50;
				track.style.transform = `translateX(${Math.max(-50, Math.min(0, dragPercent))}%)`;
			}
		}
	}, { passive: true });

	el.addEventListener("touchend", (e: TouchEvent) => {
		if (!chatCaptured) return;
		const track = document.querySelector(".preview-slider__track") as HTMLElement | null;
		if (track) {
			track.style.transition = "transform 0.3s ease-out";
			const dx = e.changedTouches[0].clientX - chatStartX;
			const threshold = track.parentElement!.clientWidth * 0.2;
			if (dx < -threshold) state.previewPanelTab = "preview";
			track.style.transform = `translateX(${state.previewPanelTab === "chat" ? 0 : -50}%)`;
		}
		chatCaptured = false;
		chatDecided = false;
		renderApp();
	}, { passive: true });
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

	const assistantTabBar = () => {
		if (!state.assistantType) return "";
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.assistantTab === "chat" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.assistantTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${state.assistantTab === "preview" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.assistantTab = "preview"; renderApp(); }}
				>
					Preview${state.assistantHasProposal ? html` <span class="goal-tab-dot"></span>` : ""}
				</button>
			</div>
		`;
	};

	const previewTabBar = () => {
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.previewPanelTab === "chat" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.previewPanelTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${state.previewPanelTab === "preview" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.previewPanelTab = "preview"; renderApp(); }}
				>Preview</button>
			</div>
		`;
	};

	const previewCollapseKey = () => `bobbit-preview-collapsed-${activeSessionId()}`;
	const isPreviewCollapsed = () => localStorage.getItem(previewCollapseKey()) === "true";
	const togglePreviewCollapse = () => {
		const next = !isPreviewCollapsed();
		localStorage.setItem(previewCollapseKey(), String(next));
		renderApp();
	};

	const htmlPreviewPanel = () => {
		return html`
			<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
				<div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
					<span class="text-xs font-medium text-muted-foreground" style="flex-shrink:0;">Live Preview</span>
					<span class="text-xs text-muted-foreground" style="flex:1;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:0.7;padding:0 8px;" title=${`~/.pi/preview-${activeSessionId() || ""}.html`}>~/.pi/preview-${activeSessionId() || ""}.html</span>
					<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title="Collapse preview (Ctrl+])">
						${icon(PanelRightClose, "sm")}
					</button>
				</div>
				<div style="position:relative;flex:1;min-height:0;">
					<iframe
						class="w-full border-0"
						style="position:absolute;inset:0;height:100%;"
						sandbox="allow-scripts allow-same-origin"
						.srcdoc=${state.previewPanelHtml + PREVIEW_SWIPE_SCRIPT}
					></iframe>
				</div>
			</div>
		`;
	};

	const previewExpandButton = () => html`
		<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:6px 4px;border-left:1px solid var(--border);align-self:stretch;display:flex;align-items:center;" title="Expand preview (Ctrl+])">
			${icon(PanelRightOpen, "sm")}
		</button>
	`;

	const mainArea = () => {
		// Goal dashboard route
		const route = getRouteFromHash();
		if (route.view === "goal-dashboard" && route.goalId) {
			return renderGoalDashboard();
		}
		if (route.view === "roles" || route.view === "role-edit") {
			return renderRoleManagerPage();
		}
		if (route.view === "tools" || route.view === "tool-edit") {
			return renderToolManagerPage();
		}
		if (route.view === "artifact-specs" || route.view === "artifact-spec-edit") {
			return renderArtifactSpecPage();
		}
		if (route.view === "personalities" || route.view === "personality-edit") {
			return renderPersonalityManagerPage();
		}

		if (connected && state.assistantType) {
			const previewPanel = getAssistantPreviewPanel(state.assistantType);
			if (desktop) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0 overflow-hidden">
						<div class="goal-chat-panel flex-1 min-w-0 flex flex-col">${state.chatPanel}</div>
						${previewPanel}
					</div>
				`;
			}
			return html`
				${reconnectBanner()}
				${state.assistantTab === "chat"
					? html`<div class="flex-1 min-h-0 flex flex-col">${state.chatPanel}</div>`
					: html`<div class="flex-1 min-h-0 flex flex-col">${previewPanel}</div>`
				}
			`;
		}
		if (connected && state.isPreviewSession) {
			if (desktop) {
				const collapsed = isPreviewCollapsed();
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0 overflow-hidden">
						<div class="${collapsed ? 'flex-1' : 'goal-chat-panel flex-1'} min-w-0 flex flex-col">${state.chatPanel}</div>
						${collapsed ? previewExpandButton() : htmlPreviewPanel()}
					</div>
				`;
			}
			const slideX = state.previewPanelTab === "chat" ? 0 : -50;
			return html`
				${reconnectBanner()}
				<div class="preview-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
					<div class="preview-slider__track" style="display:flex;width:200%;height:100%;transform:translateX(${slideX}%);transition:transform 0.3s ease-out;will-change:transform;">
						<div style="width:50%;height:100%;min-width:0;display:flex;flex-direction:column;">${state.chatPanel}</div>
						<div style="width:50%;height:100%;min-width:0;display:flex;flex-direction:column;">${htmlPreviewPanel()}</div>
					</div>
				</div>
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
					${state.assistantType ? assistantTabBar() : ""}
					${state.isPreviewSession && !state.assistantType ? previewTabBar() : ""}
				</div>
				<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
		ensureMobileScrollTracking();
		setupPreviewSwipe();
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
