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
	goalId?: string;
	goalAssistant?: boolean;
	colorIndex?: number;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a swarm goal */
	role?: string;
	/** The swarm goal this agent belongs to */
	swarmGoalId?: string;
	/** Git worktree path */
	worktreePath?: string;
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
	swarm?: boolean;
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
	previewSwarmMode: false,
	previewWorktree: false,
	cwdDropdownOpen: false,
	cwdHighlightIndex: -1,
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

export function saveExpandedGoals(): void {
	localStorage.setItem(EXPANDED_GOALS_KEY, JSON.stringify([...expandedGoals]));
}

export function setUngroupedExpanded(value: boolean): void {
	ungroupedExpanded = value;
	localStorage.setItem(UNGROUPED_EXPANDED_KEY, String(value));
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
