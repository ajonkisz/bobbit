import { ChatPanel } from "../ui/index.js";
import type { GoalDraft } from "../ui/storage/stores/goal-draft-store.js";
import type { ConnectionStatus } from "./remote-agent.js";
import { RemoteAgent } from "./remote-agent.js";
import {
	state,
	renderApp,
	activeSessionId,
	isDesktop,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GW_SESSION_KEY,
} from "./state.js";
import { gatewayFetch, refreshSessions, startSessionPolling, updateLocalSessionTitle, updateLocalSessionStatus, fetchGitStatus } from "./api.js";
import { getRouteFromHash, setHashRoute, saveSessionModel, loadSessionModel, clearSessionModel, saveDraft, loadDraft } from "./routing.js";
import { sessionHueRotation } from "./session-colors.js";
import { showConnectionError, confirmAction, checkOAuthStatus, openOAuthDialog } from "./dialogs.js";
import { teardownMobileScrollTracking } from "./mobile-header.js";
import { storage } from "./storage.js";

// ============================================================================
// GOAL DRAFT PERSISTENCE HELPERS
// ============================================================================

/** Debounce timer for draft saves. */
let _draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Save the current goal assistant preview state to IndexedDB (debounced 300ms). */
export function saveGoalDraft(sessionId: string): void {
	if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
	_draftSaveTimer = setTimeout(() => {
		_draftSaveTimer = null;
		const draft: GoalDraft = {
			sessionId,
			activeGoalProposal: state.activeGoalProposal ?? undefined,
			previewTitle: state.previewTitle,
			previewSpec: state.previewSpec,
			previewCwd: state.previewCwd,
			previewTitleEdited: state.previewTitleEdited,
			previewSpecEdited: state.previewSpecEdited,
			previewCwdEdited: state.previewCwdEdited,
			hasReceivedProposal: state.hasReceivedProposal,
			goalAssistantTab: state.goalAssistantTab,
			previewSwarmMode: state.previewSwarmMode,
			previewWorktree: state.previewWorktree,
		};
		storage.goalDrafts.saveDraft(draft).catch((err) => {
			console.error("[goal-draft] Failed to save draft:", err);
		});
	}, 300);
}

/** Restore goal assistant preview state from IndexedDB. Returns true if a draft was found. */
async function restoreGoalDraft(sessionId: string): Promise<boolean> {
	try {
		const draft = await storage.goalDrafts.getDraft(sessionId);
		if (!draft) return false;

		state.activeGoalProposal = draft.activeGoalProposal ?? null;
		state.previewTitle = draft.previewTitle ?? "";
		state.previewSpec = draft.previewSpec ?? "";
		state.previewCwd = draft.previewCwd ?? "";
		state.previewTitleEdited = draft.previewTitleEdited ?? false;
		state.previewSpecEdited = draft.previewSpecEdited ?? false;
		state.previewCwdEdited = draft.previewCwdEdited ?? false;
		state.hasReceivedProposal = draft.hasReceivedProposal ?? false;
		state.goalAssistantTab = draft.goalAssistantTab ?? "chat";
		state.previewSwarmMode = draft.previewSwarmMode ?? false;
		state.previewWorktree = draft.previewWorktree ?? false;
		return true;
	} catch (err) {
		console.error("[goal-draft] Failed to restore draft:", err);
		return false;
	}
}

/** Delete goal draft from IndexedDB. */
export function deleteGoalDraft(sessionId: string): void {
	storage.goalDrafts.deleteDraft(sessionId).catch((err) => {
		console.error("[goal-draft] Failed to delete draft:", err);
	});
}

// ============================================================================
// AUTHENTICATE GATEWAY
// ============================================================================

export async function authenticateGateway(url: string, token: string): Promise<void> {
	localStorage.setItem(GW_URL_KEY, url);
	localStorage.setItem(GW_TOKEN_KEY, token);

	const healthRes = await fetch(`${url}/api/health`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!healthRes.ok) {
		if (healthRes.status === 401) throw new Error("Invalid auth token");
		throw new Error(`Gateway error: ${healthRes.status}`);
	}

	const hasAuth = await checkOAuthStatus();
	if (!hasAuth) {
		const success = await openOAuthDialog();
		if (!success) throw new Error("OAuth login required");
	}

	state.appView = "authenticated";
	const route = getRouteFromHash();
	if (route.view !== "session") {
		setHashRoute("landing");
	}
	renderApp();
	await refreshSessions();
	startSessionPolling();
}

// ============================================================================
// CONNECT TO SESSION
// ============================================================================

export async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean }): Promise<void> {
	if (state.connectingSessionId) return;
	state.connectingSessionId = sessionId;

	if (state.remoteAgent) {
		state.remoteAgent.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
	}
	state.cwdDropdownOpen = false;

	renderApp();

	try {
		const url = localStorage.getItem(GW_URL_KEY)!;
		const token = localStorage.getItem(GW_TOKEN_KEY)!;

		const remote = new RemoteAgent();
		await remote.connect(url, token, sessionId);

		// Restore saved model
		const savedModel = loadSessionModel(sessionId);
		if (savedModel) {
			const { getModel } = await import("@mariozechner/pi-ai");
			try {
				const model = getModel(savedModel.provider as any, savedModel.modelId);
				remote.setModel(model);
			} catch {
				// Model no longer available
			}
		}

		// Intercept setModel to persist
		const originalSetModel = remote.setModel.bind(remote);
		remote.setModel = (model: any) => {
			originalSetModel(model);
			if (model?.provider && model?.id) {
				saveSessionModel(sessionId, model.provider, model.id);
			}
			renderApp();
		};

		// Clear draft on prompt
		const originalPrompt = remote.prompt.bind(remote);
		remote.prompt = (...args: Parameters<typeof remote.prompt>) => {
			localStorage.removeItem(`bobbit-draft-${sessionId}`);
			return originalPrompt(...args);
		};

		// Callbacks
		remote.onTitleChange = (newTitle: string) => {
			updateLocalSessionTitle(sessionId, newTitle);
			renderApp();
			refreshSessions();
		};

		remote.onStatusChange = (status: string) => {
			updateLocalSessionStatus(sessionId, status);
			const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) {
				state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], isAborting: remote.isAborting };
			}
			// Refresh git status when agent becomes idle (turn finished)
			if (status === "idle") {
				refreshGitStatusForSession(sessionId);
			}
			renderApp();
		};

		remote.onConnectionStatusChange = (status: ConnectionStatus) => {
			state.connectionStatus = status;
			renderApp();
		};

		remote.onWorkflowUpdate = () => renderApp();

		remote.onGoalProposal = (proposal) => {
			state.activeGoalProposal = proposal;
			if (!state.previewTitleEdited) state.previewTitle = proposal.title;
			if (!state.previewCwdEdited) state.previewCwd = proposal.cwd || "";
			if (!state.previewSpecEdited) state.previewSpec = proposal.spec;
			state.hasReceivedProposal = true;
			if (state.goalAssistantTab === "chat" && !isDesktop()) {
				state.goalAssistantTab = "preview";
			}
			// Persist draft to IndexedDB
			saveGoalDraft(sessionId);
			renderApp();
		};

		state.connectionStatus = "connected";
		state.remoteAgent = remote;
		state.appView = "authenticated";
		localStorage.setItem(GW_SESSION_KEY, sessionId);

		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${sessionHueRotation(sessionId)}deg`);
		const sessionForRole = state.gatewaySessions.find((s) => s.id === sessionId);
		document.documentElement.classList.toggle("bobbit-crowned", sessionForRole?.role === "team-lead");
		document.documentElement.classList.toggle("bobbit-bandana", sessionForRole?.role === "coder");
		// Replace history entry when navigating from goal dashboard so browser-back
		// goes to the landing page instead of back to the goal dashboard.
		const currentRoute = getRouteFromHash();
		const replaceHistory = currentRoute.view === "goal-dashboard";
		setHashRoute("session", sessionId, replaceHistory);

		const modelProvider = remote.state.model?.provider || "anthropic";
		await storage.providerKeys.set(modelProvider, "gateway-managed");

		state.chatPanel = new ChatPanel();
		await state.chatPanel.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});

		// Set cwd and branch on the AgentInterface stats bar
		const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		if (state.chatPanel.agentInterface && sessionData?.cwd) {
			state.chatPanel.agentInterface.cwd = sessionData.cwd;
			// Look up branch from the goal if this session belongs to one
			if (sessionData.goalId) {
				const goal = state.goals.find((g) => g.id === sessionData.goalId);
				if (goal?.branch) {
					state.chatPanel.agentInterface.branch = goal.branch;
				}
			}
		}

		// Initial git status fetch
		refreshGitStatusForSession(sessionId);

		if (isExisting) {
			remote.requestMessages();
		}

		// Track goal assistant state
		state.isGoalAssistantSession = options?.isGoalAssistant || sessionData?.goalAssistant || false;

		if (state.isGoalAssistantSession) {
			// Try to restore persisted draft state; fall back to fresh defaults
			const restored = await restoreGoalDraft(sessionId);
			if (!restored) {
				state.goalAssistantTab = "chat";
				state.previewTitle = "";
				state.previewCwd = "";
				state.previewSpec = "";
				state.previewTitleEdited = false;
				state.previewCwdEdited = false;
				state.previewSpecEdited = false;
				state.hasReceivedProposal = false;
				state.previewSwarmMode = false;
			}
			state.previewSpecEditMode = false;
		}

		if (options?.isGoalAssistant && !isExisting) {
			remote.prompt("Start the goal creation session.");
		}

		// Restore draft and set up auto-save
		requestAnimationFrame(() => {
			const editor = document.querySelector("message-editor") as any;
			if (editor) {
				const draft = loadDraft(sessionId);
				if (draft) editor.value = draft;
				const origOnInput = editor.onInput;
				editor.onInput = (val: string) => {
					origOnInput?.(val);
					saveDraft(sessionId, val);
				};
				const textarea = editor.querySelector("textarea");
				if (textarea) textarea.focus();
			}
		});

		refreshSessions();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Connection Failed", `Could not connect to session: ${msg}`);
	} finally {
		state.connectingSessionId = null;
		renderApp();
	}
}

// ============================================================================
// CREATE & CONNECT
// ============================================================================

export async function createAndConnectSession(goalId?: string): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.creatingSessionForGoalId = goalId || null;
	renderApp();
	try {
		const body: any = {};
		if (goalId) body.goalId = goalId;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		await connectToSession(id, false);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create session", msg);
	} finally {
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		renderApp();
	}
}

// ============================================================================
// TERMINATE
// ============================================================================

export async function terminateSession(sessionId: string): Promise<void> {
	const session = state.gatewaySessions.find((s) => s.id === sessionId);
	const sessionTitle = session?.title || "this session";
	const confirmed = await confirmAction(
		"Terminate Session",
		`Are you sure you want to terminate "${sessionTitle}"? This will end the agent process and cannot be undone.`,
		"Terminate",
		true,
	);
	if (!confirmed) return;

	if (activeSessionId() === sessionId) {
		state.remoteAgent?.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
		localStorage.removeItem(GW_SESSION_KEY);
		setHashRoute("landing");
		renderApp();
	}

	const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to terminate session: ${res.status}`);
	}
	clearSessionModel(sessionId);
	deleteGoalDraft(sessionId);
	await refreshSessions();
}

// ============================================================================
// DISCONNECT
// ============================================================================

export function backToSessions(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.activeGoalProposal = null;
	state.isGoalAssistantSession = false;
	state.cwdDropdownOpen = false;
	localStorage.removeItem(GW_SESSION_KEY);
	state.appView = "authenticated";
	teardownMobileScrollTracking();
	setHashRoute("landing");
	renderApp();
	refreshSessions();
}

export function disconnectGateway(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.isGoalAssistantSession = false;
	state.appView = "disconnected";
	localStorage.removeItem(GW_SESSION_KEY);
	teardownMobileScrollTracking();
	setHashRoute("landing");
	renderApp();
}

// ============================================================================
// GIT STATUS
// ============================================================================

async function refreshGitStatusForSession(sessionId: string): Promise<void> {
	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	ai.gitStatusLoading = true;
	try {
		const data = await fetchGitStatus(sessionId);
		if (data && activeSessionId() === sessionId) {
			ai.gitStatus = data;
			// Also update the branch in the stats bar
			if (data.branch) ai.branch = data.branch;
		}
	} catch {
		// silently ignore — widget just won't show
	} finally {
		if (activeSessionId() === sessionId) {
			ai.gitStatusLoading = false;
		}
	}
}
