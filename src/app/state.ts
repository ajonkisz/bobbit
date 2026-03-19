import type { ChatPanel } from "../ui/index.js";
import type { RemoteAgent, ConnectionStatus } from "./remote-agent.js";

// ============================================================================
// TYPES
// ============================================================================

export interface GatewaySession {
	id: string;
	title: string;
	cwd: string;
	status: string;
	createdAt: number;
	lastActivity: number;
	clientCount: number;
	isCompacting?: boolean;
	isAborting?: boolean;
	goalId?: string;
	goalAssistant?: boolean;
	roleAssistant?: boolean;
	colorIndex?: number;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal */
	role?: string;
	/** The team goal this agent belongs to */
	teamGoalId?: string;
	/** Git worktree path */
	worktreePath?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
}

export type GoalState = "todo" | "in-progress" | "complete" | "shelved";

export interface Goal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	spec: string;
	createdAt: number;
	updatedAt: number;
	worktreePath?: string;
	branch?: string;
	repoPath?: string;
	team?: boolean;
	teamLeadSessionId?: string;
}

export type AppView = "disconnected" | "authenticated";

// ============================================================================
// MUTABLE STATE
// ============================================================================

export const state = {
	chatPanel: null as ChatPanel | null,
	remoteAgent: null as RemoteAgent | null,
	connectionStatus: "disconnected" as ConnectionStatus,
	appView: "disconnected" as AppView,

	gatewaySessions: [] as GatewaySession[],
	goals: [] as Goal[],
	sessionsLoading: false,
	sessionsError: "",
	creatingSession: false,
	creatingSessionForGoalId: null as string | null,
	connectingSessionId: null as string | null,
	sessionPollTimer: null as ReturnType<typeof setInterval> | null,

	/** Whether the sidebar is collapsed */
	sidebarCollapsed: localStorage.getItem("bobbit-sidebar-collapsed") === "true",

	/** Active goal proposal from a goal-assistant session */
	activeGoalProposal: null as { title: string; spec: string; cwd?: string } | null,

	// Goal assistant split-screen state
	isGoalAssistantSession: false,
	goalAssistantTab: "chat" as "chat" | "preview",
	previewTitle: "",
	previewCwd: "",
	previewSpec: "",
	previewTitleEdited: false,
	previewCwdEdited: false,
	previewSpecEdited: false,
	hasReceivedProposal: false,
	previewSpecEditMode: false,
	previewTeamMode: false,
	previewWorktree: false,
	cwdDropdownOpen: false,
	cwdHighlightIndex: -1,

	/** Active role proposal from a role-assistant session */
	activeRoleProposal: null as { name: string; label: string; prompt: string; tools: string; accessory: string } | null,

	// Role assistant split-screen state
	isRoleAssistantSession: false,
	roleAssistantTab: "chat" as "chat" | "preview",
	rolePreviewName: "",
	rolePreviewLabel: "",
	rolePreviewPrompt: "",
	rolePreviewTools: "",
	rolePreviewAccessory: "none",
	rolePreviewNameEdited: false,
	rolePreviewLabelEdited: false,
	rolePreviewPromptEdited: false,
	rolePreviewToolsEdited: false,
	rolePreviewAccessoryEdited: false,
	hasReceivedRoleProposal: false,
	rolePreviewPromptEditMode: false,

	// HTML preview panel (for live visual iteration — same pattern as goal/role assistant)
	isPreviewSession: false,
	previewPanelTab: "chat" as "chat" | "preview",
	previewPanelHtml: "" as string,

	/** Currently viewed goal dashboard (null = not on dashboard) */
	goalDashboardId: null as string | null,

	/** Cached roles for the role picker menu */
	roles: [] as Array<{ name: string; label: string; accessory: string }>,
	/** Whether the new-session role picker dropdown is open */
	rolePickerOpen: false,
};

// ============================================================================
// EXPANDED GOALS PERSISTENCE
// ============================================================================

const EXPANDED_GOALS_KEY = "bobbit-expanded-goals";
const UNGROUPED_EXPANDED_KEY = "bobbit-ungrouped-expanded";

export let expandedGoals: Set<string> = new Set(
	JSON.parse(localStorage.getItem(EXPANDED_GOALS_KEY) || "[]"),
);
export let ungroupedExpanded =
	localStorage.getItem(UNGROUPED_EXPANDED_KEY) !== "false";

const COLLAPSED_TEAM_LEADS_KEY = "bobbit-collapsed-team-leads";
export let collapsedTeamLeadSessions: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_TEAM_LEADS_KEY) || "[]"),
);

export function saveExpandedGoals(): void {
	localStorage.setItem(EXPANDED_GOALS_KEY, JSON.stringify([...expandedGoals]));
}

export function setUngroupedExpanded(value: boolean): void {
	ungroupedExpanded = value;
	localStorage.setItem(UNGROUPED_EXPANDED_KEY, String(value));
}

export function toggleTeamLeadExpanded(sessionId: string): void {
	if (collapsedTeamLeadSessions.has(sessionId)) {
		collapsedTeamLeadSessions.delete(sessionId);
	} else {
		collapsedTeamLeadSessions.add(sessionId);
	}
	localStorage.setItem(COLLAPSED_TEAM_LEADS_KEY, JSON.stringify([...collapsedTeamLeadSessions]));
}

export function isTeamLeadExpanded(sessionId: string): boolean {
	return !collapsedTeamLeadSessions.has(sessionId);
}

// ============================================================================
// RENDER CALLBACK (set during init to break circular deps)
// ============================================================================

let _renderApp: () => void = () => {};

export function setRenderApp(fn: () => void): void {
	_renderApp = fn;
}

export function renderApp(): void {
	_renderApp();
}

// ============================================================================
// HELPERS
// ============================================================================

export const SIDEBAR_BREAKPOINT = 768;
let windowWidth = window.innerWidth;

window.addEventListener("resize", () => {
	const prev = windowWidth;
	windowWidth = window.innerWidth;
	if ((prev < SIDEBAR_BREAKPOINT) !== (windowWidth < SIDEBAR_BREAKPOINT)) {
		renderApp();
	}
});

export function isDesktop(): boolean {
	return windowWidth >= SIDEBAR_BREAKPOINT;
}

export function hasActiveSession(): boolean {
	return state.remoteAgent !== null && state.remoteAgent.connected;
}

export function activeSessionId(): string | undefined {
	return state.remoteAgent?.gatewaySessionId;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const GW_SESSION_KEY = "gateway.sessionId";

export const GOAL_STATE_LABELS: Record<GoalState, string> = {
	"todo": "To Do",
	"in-progress": "In Progress",
	"complete": "Complete",
	"shelved": "Shelved",
};

export const GOAL_STATE_COLORS: Record<GoalState, string> = {
	"todo": "text-muted-foreground",
	"in-progress": "text-yellow-600 dark:text-yellow-400",
	"complete": "text-green-600 dark:text-green-400",
	"shelved": "text-muted-foreground opacity-60",
};
