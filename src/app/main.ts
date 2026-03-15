import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ModelSelector,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "../ui/index.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html, render, svg } from "lit";
import { ArrowLeft, Brain, Crosshair, PanelLeftClose, PanelLeftOpen, Pencil, Plus, QrCode, Server, Sparkles, Trash2, Unplug, WandSparkles } from "lucide";
import QRCode from "qrcode";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "./app.css";
import { RemoteAgent, type ConnectionStatus } from "./remote-agent.js";

// ============================================================================
// STORAGE (required by web-ui components)
// ============================================================================
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 1,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// ============================================================================
// STATE
// ============================================================================
let chatPanel: ChatPanel;
let remoteAgent: RemoteAgent | null = null;
let connectionStatus: ConnectionStatus = "disconnected";

type AppView = "disconnected" | "authenticated";
let appView: AppView = "disconnected";

interface GatewaySession {
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
}

type GoalState = "todo" | "in-progress" | "complete" | "shelved";

interface Goal {
	id: string;
	title: string;
	cwd: string;
	state: GoalState;
	spec: string;
	createdAt: number;
	updatedAt: number;
}

let gatewaySessions: GatewaySession[] = [];
let goals: Goal[] = [];
let sessionsLoading = false;
let sessionsError = "";
let creatingSession = false;
let creatingSessionForGoalId: string | null = null;
let connectingSessionId: string | null = null;
let sessionPollTimer: ReturnType<typeof setInterval> | null = null;
/** Track which goals are expanded in the sidebar (persisted to localStorage) */
const EXPANDED_GOALS_KEY = "bobbit-expanded-goals";
const UNGROUPED_EXPANDED_KEY = "bobbit-ungrouped-expanded";
let expandedGoals: Set<string> = new Set(JSON.parse(localStorage.getItem(EXPANDED_GOALS_KEY) || "[]"));
let ungroupedExpanded = localStorage.getItem(UNGROUPED_EXPANDED_KEY) !== "false";

function saveExpandedGoals() {
	localStorage.setItem(EXPANDED_GOALS_KEY, JSON.stringify([...expandedGoals]));
}
function saveUngroupedExpanded() {
	localStorage.setItem(UNGROUPED_EXPANDED_KEY, String(ungroupedExpanded));
}
/** Whether the sidebar is collapsed (persisted to localStorage) */
let sidebarCollapsed = localStorage.getItem("bobbit-sidebar-collapsed") === "true";
/** Active goal proposal from a goal-assistant session */
let activeGoalProposal: { title: string; spec: string; cwd?: string } | null = null;

// ── Goal assistant split-screen state ─────────────────────────────
/** Whether the currently connected session is a goal assistant */
let isGoalAssistantSession = false;
/** Mobile tab for goal assistant view */
let goalAssistantTab: "chat" | "preview" = "chat";
/** Editable preview state — persists user edits across proposal updates */
let previewTitle = "";
let previewCwd = "";
let previewSpec = "";
/** Track which fields the user has manually edited since the last proposal */
let previewTitleEdited = false;
let previewCwdEdited = false;
let previewSpecEdited = false;
/** Whether we've received at least one proposal */
let hasReceivedProposal = false;
/** Whether the preview spec is in edit mode (vs rendered markdown) */
let previewSpecEditMode = false;

const SIDEBAR_BREAKPOINT = 768;
let windowWidth = window.innerWidth;
window.addEventListener("resize", () => {
	const prev = windowWidth;
	windowWidth = window.innerWidth;
	// Only re-render if we crossed the breakpoint
	if ((prev < SIDEBAR_BREAKPOINT) !== (windowWidth < SIDEBAR_BREAKPOINT)) {
		renderApp();
	}
});

function isDesktop(): boolean {
	return windowWidth >= SIDEBAR_BREAKPOINT;
}

function hasActiveSession(): boolean {
	return remoteAgent !== null && remoteAgent.connected;
}

function activeSessionId(): string | undefined {
	return remoteAgent?.gatewaySessionId;
}

// ============================================================================
// MOBILE HEADER AUTO-HIDE
//
// Uses capture-phase scroll listening on #app-main so we don't need to
// query for the specific scroll container inside Lit custom elements.
// Scroll events don't bubble, but capture: true intercepts them from
// any descendant.
//
// The header overlays content (no paddingTop management) and slides in/out
// via translateY. A CSS rule in app.css adds extra top-padding to the
// message area on mobile so the first message isn't hidden behind the header.
// ============================================================================
let mobileHeaderVisible = true;
let _scrollCleanup: (() => void) | null = null;
let _lastTrackedScrollTop = 0;

function setupMobileScrollTracking(): void {
	if (isDesktop() || !hasActiveSession()) {
		teardownMobileScrollTracking();
		mobileHeaderVisible = true;
		return;
	}

	// If already tracking, don't recreate
	// (avoids resetting _lastTrackedScrollTop on every renderApp)
	if (_scrollCleanup) return;

	const mainEl = document.getElementById("app-main");
	if (!mainEl) return;

	_lastTrackedScrollTop = 0;

	const onScroll = (e: Event) => {
		const headerEl = document.getElementById("app-header");
		if (!headerEl) return;

		// The scroll target is the element that actually scrolled
		const target = e.target as HTMLElement;
		if (!target || (!target.scrollTop && target.scrollTop !== 0)) return;

		const currentTop = target.scrollTop;
		const delta = currentTop - _lastTrackedScrollTop;

		if (currentTop < 20) {
			// Near top of content — always show header
			if (!mobileHeaderVisible) {
				mobileHeaderVisible = true;
				headerEl.style.transform = "translateY(0)";
				headerEl.style.boxShadow = "";
			}
		} else if (delta < -4) {
			// Scrolling UP — show header
			if (!mobileHeaderVisible) {
				mobileHeaderVisible = true;
				headerEl.style.transform = "translateY(0)";
				headerEl.style.boxShadow = "0 1px 3px rgba(0,0,0,0.1)";
			}
		} else if (delta > 4) {
			// Scrolling DOWN — hide header
			if (mobileHeaderVisible) {
				mobileHeaderVisible = false;
				headerEl.style.transform = "translateY(-100%)";
				headerEl.style.boxShadow = "";
			}
		}

		_lastTrackedScrollTop = currentTop;
	};

	// Capture phase: intercepts scroll events from ANY descendant,
	// even though scroll events don't bubble.
	mainEl.addEventListener("scroll", onScroll, { capture: true, passive: true });
	_scrollCleanup = () => {
		mainEl.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
		_scrollCleanup = null;
	};
}

function teardownMobileScrollTracking(): void {
	_scrollCleanup?.();
}

function ensureMobileScrollTracking(): void {
	setupMobileScrollTracking();
}

const GW_URL_KEY = "gateway.url";
const GW_TOKEN_KEY = "gateway.token";
const GW_SESSION_KEY = "gateway.sessionId";
const DRAFT_PREFIX = "bobbit-draft-";

/** Save a draft prompt for a session (debounced) */
let _draftTimer: ReturnType<typeof setTimeout> | null = null;
function saveDraft(sessionId: string, text: string): void {
	if (_draftTimer) clearTimeout(_draftTimer);
	_draftTimer = setTimeout(() => {
		if (text.trim()) {
			localStorage.setItem(DRAFT_PREFIX + sessionId, text);
		} else {
			localStorage.removeItem(DRAFT_PREFIX + sessionId);
		}
	}, 100);
}

/** Load and clear a draft prompt for a session */
function loadDraft(sessionId: string): string {
	return localStorage.getItem(DRAFT_PREFIX + sessionId) || "";
}

// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected)
// ============================================================================

function getRouteFromHash(): { view: "landing" | "session"; sessionId?: string } {
	const hash = window.location.hash || "";
	const sessionMatch = hash.match(/^#\/session\/([a-f0-9-]+)$/i);
	if (sessionMatch) {
		return { view: "session", sessionId: sessionMatch[1] };
	}
	return { view: "landing" };
}

function setHashRoute(view: "landing" | "session", sessionId?: string): void {
	const newHash = view === "session" && sessionId ? `#/session/${sessionId}` : "#/";
	if (window.location.hash !== newHash) {
		window.location.hash = newHash;
	}
}

// ============================================================================
// PER-SESSION MODEL PERSISTENCE
// ============================================================================

function saveSessionModel(sessionId: string, provider: string, modelId: string): void {
	localStorage.setItem(`session.${sessionId}.model`, JSON.stringify({ provider, modelId }));
}

function loadSessionModel(sessionId: string): { provider: string; modelId: string } | null {
	const raw = localStorage.getItem(`session.${sessionId}.model`);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.provider && parsed.modelId) return parsed;
	} catch {}
	return null;
}

function clearSessionModel(sessionId: string): void {
	localStorage.removeItem(`session.${sessionId}.model`);
}

// ============================================================================
// GATEWAY API HELPERS
// ============================================================================
function gatewayFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const url = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	return fetch(`${url}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}

// ============================================================================
// OAUTH
// ============================================================================
async function checkOAuthStatus(): Promise<boolean> {
	const res = await gatewayFetch("/api/oauth/status");
	if (!res.ok) return false;
	const data = await res.json();
	return data.authenticated === true;
}

function openOAuthDialog(): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		let flowId = "";
		let authUrl = "";
		let codeValue = "";
		let step: "loading" | "waiting" | "exchanging" | "done" | "error" = "loading";
		let error = "";

		const cleanup = (result: boolean) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		const startFlow = async () => {
			try {
				const res = await gatewayFetch("/api/oauth/start", { method: "POST" });
				if (!res.ok) throw new Error("Failed to start OAuth flow");
				const data = await res.json();
				flowId = data.flowId;
				authUrl = data.url;
				step = "waiting";
				window.open(authUrl, "_blank");
				renderOAuthDialog();
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				step = "error";
				renderOAuthDialog();
			}
		};

		const handleSubmitCode = async () => {
			if (!codeValue.trim()) return;
			step = "exchanging";
			renderOAuthDialog();

			try {
				const res = await gatewayFetch("/api/oauth/complete", {
					method: "POST",
					body: JSON.stringify({ flowId, code: codeValue.trim() }),
				});
				const data = await res.json();
				if (data.success) {
					step = "done";
					renderOAuthDialog();
					setTimeout(() => cleanup(true), 500);
				} else {
					error = data.error || "OAuth exchange failed";
					step = "error";
					renderOAuthDialog();
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				step = "error";
				renderOAuthDialog();
			}
		};

		const renderOAuthDialog = () => {
			const content = (() => {
				switch (step) {
					case "loading":
						return html`<p class="text-sm text-muted-foreground">Starting OAuth flow...</p>`;
					case "waiting":
						return html`
							<div class="flex flex-col gap-3">
								<p class="text-sm text-muted-foreground">
									A browser tab has been opened for Anthropic authentication.
									After authorizing, copy the code and paste it below.
								</p>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Authorization Code</label>
									${Input({
										type: "text",
										placeholder: "Paste code here (format: code#state)",
										value: codeValue,
										onInput: (e: Event) => {
											codeValue = (e.target as HTMLInputElement).value;
											renderOAuthDialog();
										},
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleSubmitCode();
											}
										},
									})}
								</div>
								<p class="text-xs text-muted-foreground">
									Didn't open?
									<a href="${authUrl}" target="_blank" class="underline text-foreground">Click here</a>
								</p>
							</div>
						`;
					case "exchanging":
						return html`<p class="text-sm text-muted-foreground">Exchanging code for tokens...</p>`;
					case "done":
						return html`<p class="text-sm text-green-600 dark:text-green-400">Authenticated successfully.</p>`;
					case "error":
						return html`
							<div class="flex flex-col gap-2">
								<p class="text-sm text-red-500">${error}</p>
								${Button({ variant: "default", size: "sm", onClick: () => { step = "loading"; startFlow(); }, children: "Try again" })}
							</div>
						`;
				}
			})();

			render(
				Dialog({
					isOpen: true,
					onClose: () => cleanup(false),
					width: "min(480px, 92vw)",
					height: "auto",
					backdropClassName: "bg-black/50 backdrop-blur-sm",
					children: html`
						${DialogContent({
							children: html`
								${DialogHeader({ title: "Anthropic Login" })}
								<div class="mt-2">${content}</div>
							`,
						})}
						${step === "waiting"
							? DialogFooter({
									className: "px-6 pb-4",
									children: html`
										<div class="flex gap-2 justify-end">
											${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
											${Button({
												variant: "default",
												onClick: handleSubmitCode,
												disabled: !codeValue.trim(),
												children: "Submit",
											})}
										</div>
									`,
								})
							: step === "error"
								? DialogFooter({
										className: "px-6 pb-4",
										children: html`
											<div class="flex gap-2 justify-end">
												${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
											</div>
										`,
									})
								: ""}
					`,
				}),
				container,
			);
		};

		renderOAuthDialog();
		startFlow();
	});
}

// ============================================================================
// GATEWAY CONNECTION (Phase 1: authenticate, Phase 2: show landing, Phase 3: join session)
// ============================================================================

/** Phase 1: Verify gateway reachable + OAuth, then show session landing page */
async function authenticateGateway(url: string, token: string): Promise<void> {
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

	// Authenticated — show session UI
	appView = "authenticated";
	const route = getRouteFromHash();
	if (route.view !== "session") {
		setHashRoute("landing");
	}
	renderApp();
	await refreshSessions();
	startSessionPolling();
}

/** Fetch session list from the gateway */
/**
 * Optimistically update a session's title in the local gatewaySessions array.
 * This ensures the sidebar shows the new title immediately, even before the
 * server round-trip completes (avoids stale data when switching sessions).
 */
function updateLocalSessionTitle(sessionId: string, title: string): void {
	const idx = gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		gatewaySessions[idx] = { ...gatewaySessions[idx], title };
		renderApp();
	}
}

function updateLocalSessionStatus(sessionId: string, status: string): void {
	const idx = gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		gatewaySessions[idx] = { ...gatewaySessions[idx], status, lastActivity: Date.now() };
		renderApp();
	}
}

/** Poll session list every 5s to keep sidebar status/activity up to date */
function startSessionPolling(): void {
	stopSessionPolling();
	sessionPollTimer = setInterval(() => {
		// Only poll if we're authenticated and the page is visible
		if (appView === "authenticated" && document.visibilityState === "visible") {
			refreshSessions();
		}
	}, 5_000);
}

function stopSessionPolling(): void {
	if (sessionPollTimer) {
		clearInterval(sessionPollTimer);
		sessionPollTimer = null;
	}
}

async function refreshSessions(): Promise<void> {
	// Only show loading spinner on initial fetch, not background polls
	const isInitial = gatewaySessions.length === 0 && !sessionsError;
	if (isInitial) {
		sessionsLoading = true;
		sessionsError = "";
		renderApp();
	}

	try {
		const [sessionsRes, goalsRes] = await Promise.all([
			gatewayFetch("/api/sessions"),
			gatewayFetch("/api/goals"),
		]);
		if (!sessionsRes.ok) throw new Error(`Failed to fetch sessions: ${sessionsRes.status}`);
		const sessionsData = await sessionsRes.json();
		gatewaySessions = sessionsData.sessions || [];

		// Hydrate color map from server data, then assign colors to any new sessions
		for (const s of gatewaySessions) {
			if (s.colorIndex !== undefined && !sessionColorMap.has(s.id)) {
				sessionColorMap.set(s.id, s.colorIndex);
			}
			sessionHueRotation(s.id); // assigns if not yet mapped
		}

		if (goalsRes.ok) {
			const goalsData = await goalsRes.json();
			goals = goalsData.goals || [];
			// Auto-expand goals that have active sessions
			for (const g of goals) {
				if (gatewaySessions.some((s) => s.goalId === g.id)) {
					expandedGoals.add(g.id);
				}
			}
		}

		sessionsError = "";
	} catch (err) {
		// On background poll failure, keep existing data instead of clearing
		if (isInitial) {
			sessionsError = err instanceof Error ? err.message : String(err);
			gatewaySessions = [];
		}
	} finally {
		sessionsLoading = false;
		renderApp();
	}
}

// ============================================================================
// GOAL API HELPERS
// ============================================================================

async function createGoal(title: string, cwd: string, spec = ""): Promise<Goal | null> {
	try {
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title, cwd, spec }),
		});
		if (!res.ok) throw new Error(`Failed to create goal: ${res.status}`);
		const goal = await res.json();
		await refreshSessions();
		expandedGoals.add(goal.id);
		saveExpandedGoals();
		return goal;
	} catch (err) {
		showConnectionError("Failed to create goal", err instanceof Error ? err.message : String(err));
		return null;
	}
}

async function updateGoal(id: string, updates: Partial<Pick<Goal, "title" | "cwd" | "state" | "spec">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw new Error(`Failed to update goal: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to update goal", err instanceof Error ? err.message : String(err));
		return false;
	}
}

async function deleteGoal(id: string): Promise<void> {
	const goal = goals.find((g) => g.id === id);
	const goalTitle = goal?.title || "this goal";
	const sessionsUnderGoal = gatewaySessions.filter((s) => s.goalId === id);

	let message = `Are you sure you want to delete "${goalTitle}"?`;
	if (sessionsUnderGoal.length > 0) {
		message += ` Its ${sessionsUnderGoal.length} session(s) will become ungrouped.`;
	}

	const confirmed = await confirmAction("Delete Goal", message, "Delete", true);
	if (!confirmed) return;

	try {
		await gatewayFetch(`/api/goals/${id}`, { method: "DELETE" });
		expandedGoals.delete(id);
		saveExpandedGoals();
		await refreshSessions();
	} catch (err) {
		showConnectionError("Failed to delete goal", err instanceof Error ? err.message : String(err));
	}
}

/** Show a transient error toast for connection/creation failures */
function showConnectionError(title: string, message: string): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	render(
		Dialog({
			isOpen: true,
			onClose: cleanup,
			width: "min(400px, 92vw)",
			height: "auto",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						${DialogHeader({ title })}
						<p class="text-sm text-destructive mt-2">${message}</p>
					`,
				})}
				${DialogFooter({
					className: "px-6 pb-4",
					children: html`
						<div class="flex gap-2 justify-end">
							${Button({ variant: "default", onClick: cleanup, children: "OK" })}
						</div>
					`,
				})}
			`,
		}),
		container,
	);
}

/** Phase 2: Connect to a specific session (existing or newly created) */
async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean }): Promise<void> {
	// Guard against concurrent connection attempts — if we're already
	// connecting to ANY session, bail out. This prevents parallel WebSocket
	// races when the user taps quickly on mobile.
	if (connectingSessionId) return;

	connectingSessionId = sessionId;

	// Disconnect previous session before connecting to the new one.
	// Without this, the old RemoteAgent's WebSocket stays open and its
	// callbacks (onConnectionStatusChange, auto-reconnect) can interfere
	// with global state — causing the UI to flash a reconnect banner or
	// even swap back to the old session.
	if (remoteAgent) {
		remoteAgent.disconnect();
		remoteAgent = null;
		connectionStatus = "disconnected";
	}

	renderApp();

	try {
		const url = localStorage.getItem(GW_URL_KEY)!;
		const token = localStorage.getItem(GW_TOKEN_KEY)!;

		const remote = new RemoteAgent();
		await remote.connect(url, token, sessionId);

		// Restore saved model for this session (if any)
		const savedModel = loadSessionModel(sessionId);
		if (savedModel) {
			const { getModel } = await import("@mariozechner/pi-ai");
			try {
				const model = getModel(savedModel.provider as any, savedModel.modelId);
				remote.setModel(model);
			} catch {
				// Model no longer available — ignore, use server default
			}
		}

		// Intercept setModel to persist the choice per session and re-render header
		const originalSetModel = remote.setModel.bind(remote);
		remote.setModel = (model: any) => {
			originalSetModel(model);
			if (model?.provider && model?.id) {
				saveSessionModel(sessionId, model.provider, model.id);
			}
			renderApp();
		};

		// Clear draft when a prompt is sent
		const originalPrompt = remote.prompt.bind(remote);
		remote.prompt = (...args: Parameters<typeof remote.prompt>) => {
			localStorage.removeItem(DRAFT_PREFIX + sessionId);
			if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
			return originalPrompt(...args);
		};

		// Re-render when the session title is updated (e.g. AI-generated summary)
		remote.onTitleChange = (newTitle: string) => {
			// Optimistically update local sidebar data so title isn't lost if user
			// navigates away before the next refreshSessions() REST call completes.
			updateLocalSessionTitle(sessionId, newTitle);
			renderApp();
			// Also refresh the sidebar from server for full consistency
			refreshSessions();
		};

		// Update sidebar status dot in real-time when agent starts/stops streaming
		remote.onStatusChange = (status: string) => {
			updateLocalSessionStatus(sessionId, status);
			renderApp();
		};

		// Track WebSocket connection status for reconnect banner
		remote.onConnectionStatusChange = (status: ConnectionStatus) => {
			connectionStatus = status;
			renderApp();
		};

		// Detect goal proposals from goal-assistant sessions
		remote.onGoalProposal = (proposal) => {
			activeGoalProposal = proposal;
			// Update preview fields, respecting user edits
			if (!previewTitleEdited) previewTitle = proposal.title;
			if (!previewCwdEdited) previewCwd = proposal.cwd || "";
			if (!previewSpecEdited) previewSpec = proposal.spec;
			hasReceivedProposal = true;
			// Auto-switch to preview tab on first proposal (mobile)
			if (goalAssistantTab === "chat" && !isDesktop()) {
				goalAssistantTab = "preview";
			}
			renderApp();
		};

		connectionStatus = "connected";

		remoteAgent = remote;
		appView = "authenticated";
		localStorage.setItem(GW_SESSION_KEY, sessionId);

		// Set session color for the streaming bobbit blob
		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${sessionHueRotation(sessionId)}deg`);
		setHashRoute("session", sessionId);

		const modelProvider = remote.state.model?.provider || "anthropic";
		await storage.providerKeys.set(modelProvider, "gateway-managed");

		// Create a fresh ChatPanel each time so old messages don't linger
		chatPanel = new ChatPanel();
		await chatPanel.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});

		// Model and thinking selectors are in the message editor's bottom bar

		if (isExisting) {
			remote.requestMessages();
		}

		// Track goal assistant state — check options first, then fall back to server data
		const sessionData = gatewaySessions.find((s) => s.id === sessionId);
		isGoalAssistantSession = options?.isGoalAssistant || sessionData?.goalAssistant || false;

		// Reset preview state when entering a goal assistant session
		if (isGoalAssistantSession) {
			goalAssistantTab = "chat";
			previewTitle = "";
			previewCwd = "";
			previewSpec = "";
			previewTitleEdited = false;
			previewCwdEdited = false;
			previewSpecEdited = false;
			hasReceivedProposal = false;
			previewSpecEditMode = false;
		}

		// Auto-prompt goal assistant sessions so the agent greets the user immediately
		if (options?.isGoalAssistant && !isExisting) {
			remote.prompt("Start the goal creation session.");
		}

		// Restore draft and set up auto-save, then focus input
		requestAnimationFrame(() => {
			const editor = document.querySelector("message-editor") as any;
			if (editor) {
				const draft = loadDraft(sessionId);
				if (draft) editor.value = draft;
				// Save draft on every keystroke
				const origOnInput = editor.onInput;
				editor.onInput = (val: string) => {
					origOnInput?.(val);
					saveDraft(sessionId, val);
				};
				const textarea = editor.querySelector("textarea");
				if (textarea) textarea.focus();
			}
		});

		// Refresh sidebar session list so active session appears highlighted
		refreshSessions();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Connection Failed", `Could not connect to session: ${msg}`);
	} finally {
		connectingSessionId = null;
		renderApp();
	}
}

/** Create a brand-new session on the gateway, then connect to it */
async function createAndConnectSession(goalId?: string): Promise<void> {
	if (creatingSession) return;
	creatingSession = true;
	creatingSessionForGoalId = goalId || null;
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
		creatingSession = false;
		creatingSessionForGoalId = null;
		renderApp();
	}
}

/** Show a confirmation dialog. Returns a promise that resolves true if confirmed. */
function confirmAction(title: string, message: string, confirmLabel = "Confirm", destructive = false): Promise<boolean> {
	return new Promise((resolve) => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const cleanup = (result: boolean) => {
			render(html``, container);
			container.remove();
			resolve(result);
		};

		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(false),
				width: "min(400px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title })}
							<p class="text-sm text-muted-foreground mt-2">${message}</p>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => cleanup(false), children: "Cancel" })}
								${Button({
									variant: destructive ? "destructive" as any : "default",
									onClick: () => cleanup(true),
									children: confirmLabel,
									className: destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : "",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	});
}

/** Terminate a session on the gateway */
async function terminateSession(sessionId: string): Promise<void> {
	const session = gatewaySessions.find((s) => s.id === sessionId);
	const sessionTitle = session?.title || "this session";
	const confirmed = await confirmAction(
		"Terminate Session",
		`Are you sure you want to terminate "${sessionTitle}"? This will end the agent process and cannot be undone.`,
		"Terminate",
		true,
	);
	if (!confirmed) return;

	// If terminating the active session, disconnect first
	if (activeSessionId() === sessionId) {
		remoteAgent?.disconnect();
		remoteAgent = null;
		connectionStatus = "disconnected";
		localStorage.removeItem(GW_SESSION_KEY);
		setHashRoute("landing");
		renderApp();
	}

	const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to terminate session: ${res.status}`);
	}
	clearSessionModel(sessionId);
	await refreshSessions();
}

/** Disconnect from current session and go back to session list */
function backToSessions(): void {
	remoteAgent?.disconnect();
	remoteAgent = null;
	connectionStatus = "disconnected";
	activeGoalProposal = null;
	isGoalAssistantSession = false;
	localStorage.removeItem(GW_SESSION_KEY);
	appView = "authenticated";
	mobileHeaderVisible = true;
	teardownMobileScrollTracking();
	setHashRoute("landing");
	renderApp();
	refreshSessions();
}

/** Full disconnect from gateway */
function disconnectGateway(): void {
	remoteAgent?.disconnect();
	remoteAgent = null;
	connectionStatus = "disconnected";
	isGoalAssistantSession = false;
	appView = "disconnected";
	localStorage.removeItem(GW_SESSION_KEY);
	teardownMobileScrollTracking();
	setHashRoute("landing");
	renderApp();
}

// ============================================================================
// GATEWAY DIALOG
// ============================================================================
function openGatewayDialog(): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let urlValue = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	let tokenValue = localStorage.getItem(GW_TOKEN_KEY) || "";
	let connecting = false;
	let error = "";

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const handleConnect = async () => {
		if (connecting) return;
		connecting = true;
		error = "";
		renderDialog();

		try {
			await authenticateGateway(urlValue.trim(), tokenValue.trim());
			cleanup();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			connecting = false;
			renderDialog();
		}
	};

	const renderDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(),
				width: "min(440px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Connect to Gateway" })}
							<div class="flex flex-col gap-3 mt-2">
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Gateway URL</label>
									${Input({
										type: "text",
										placeholder: "http://localhost:3001",
										value: urlValue,
										onInput: (e: Event) => {
											urlValue = (e.target as HTMLInputElement).value;
										},
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Auth Token</label>
									${Input({
										type: "password",
										placeholder: "Paste token from gateway terminal",
										value: tokenValue,
										onInput: (e: Event) => {
											tokenValue = (e.target as HTMLInputElement).value;
										},
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleConnect();
											}
										},
									})}
								</div>
								${error ? html`<p class="text-xs text-red-500">${error}</p>` : ""}
								<p class="text-xs text-muted-foreground">
									Start the gateway:
									<code class="px-1 py-0.5 rounded bg-secondary text-secondary-foreground font-mono text-[11px]">npx pi-gateway --cwd ~/project</code>
								</p>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-6",
						children: html`
							${Button({ variant: "ghost", onClick: () => cleanup(), children: "Cancel" })}
							${Button({
								variant: "default",
								onClick: handleConnect,
								children: connecting ? "Connecting..." : "Connect",
							})}
						`,
					})}
				`,
			}),
			container,
		);
	};

	renderDialog();
}

// ============================================================================
// QR CODE DIALOG
// ============================================================================
async function showQrCodeDialog(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const token = localStorage.getItem(GW_TOKEN_KEY) || "";

	// Use the current page origin so the QR code works regardless of whether
	// we're behind vite dev server or the gateway's static serving.
	const mobileUrl = `${window.location.origin}?token=${encodeURIComponent(token)}`;

	let dataUrl = "";
	let error = "";

	try {
		dataUrl = await QRCode.toDataURL(mobileUrl, {
			width: 280,
			margin: 2,
			color: { dark: "#000000", light: "#ffffff" },
		});
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	render(
		Dialog({
			isOpen: true,
			onClose: cleanup,
			width: "min(380px, 92vw)",
			height: "auto",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						${DialogHeader({ title: "Continue on Phone" })}
						<div class="flex flex-col items-center gap-3 mt-3">
							${error
								? html`<p class="text-sm text-red-500">${error}</p>`
								: html`
										<div class="rounded-lg overflow-hidden bg-white p-2">
											<img src="${dataUrl}" alt="QR Code" width="280" height="280" />
										</div>
										<p class="text-xs text-muted-foreground text-center max-w-[260px]">
											Scan with your phone camera to open this session in your mobile browser.
										</p>
									`}
						</div>
					`,
				})}
				${DialogFooter({
					className: "px-6 pb-4",
					children: html`
						<div class="flex gap-2 justify-end">
							${Button({ variant: "ghost", onClick: cleanup, children: "Close" })}
						</div>
					`,
				})}
			`,
		}),
		container,
	);
}

// ============================================================================
// GOAL DIALOGS
// ============================================================================

const GOAL_STATE_LABELS: Record<GoalState, string> = {
	"todo": "To Do",
	"in-progress": "In Progress",
	"complete": "Complete",
	"shelved": "Shelved",
};

const GOAL_STATE_COLORS: Record<GoalState, string> = {
	"todo": "text-muted-foreground",
	"in-progress": "text-yellow-600 dark:text-yellow-400",
	"complete": "text-green-600 dark:text-green-400",
	"shelved": "text-muted-foreground opacity-60",
};

/** Show the goal dialog — AI-assisted for new goals, form for editing existing ones */
function showGoalDialog(existingGoal?: Goal): void {
	if (existingGoal) {
		showGoalEditDialog(existingGoal);
	} else {
		createGoalAssistantSession();
	}
}

/** Create a goal assistant session and connect to it using the normal chat UI */
async function createGoalAssistantSession(): Promise<void> {
	if (creatingSession) return;
	creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ goalAssistant: true }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		await connectToSession(id, false, { isGoalAssistant: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create goal assistant", msg);
	} finally {
		creatingSession = false;
		renderApp();
	}
}

/** Open the edit dialog pre-filled with a proposal, then create the goal on save */
function showGoalEditDialogFromProposal(proposal: { title: string; spec: string; cwd?: string }): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = proposal.title;
	let cwdValue = proposal.cwd || "";
	let specValue = proposal.spec;
	let saving = false;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doSave = async () => {
		const trimmedTitle = titleValue.trim();
		if (!trimmedTitle) return;
		saving = true;
		renderProposalDialog();

		const sessionId = activeSessionId();
		await createGoal(trimmedTitle, cwdValue.trim(), specValue);
		activeGoalProposal = null;
		// Terminate the assistant session
		if (sessionId) {
			await terminateSession(sessionId);
		}
		saving = false;
		cleanup();
	};

	const renderProposalDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(540px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Create Goal from Proposal" })}
							<div class="mt-4 flex flex-col gap-4">
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Title</label>
									${Input({
										type: "text",
										value: titleValue,
										onInput: (e: Event) => { titleValue = (e.target as HTMLInputElement).value; renderProposalDialog(); },
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Working Directory</label>
									${Input({
										type: "text",
										placeholder: "(server default)",
										value: cwdValue,
										onInput: (e: Event) => { cwdValue = (e.target as HTMLInputElement).value; },
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Goal Spec (Markdown)</label>
									<textarea
										class="w-full min-h-[160px] max-h-[300px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
										.value=${specValue}
										@input=${(e: Event) => { specValue = (e.target as HTMLTextAreaElement).value; }}
									></textarea>
								</div>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: doSave,
									disabled: !titleValue.trim() || saving,
									children: saving ? "Creating…" : "Create Goal",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	};

	renderProposalDialog();
}

/** Form-based dialog for editing an existing goal */
function showGoalEditDialog(existingGoal: Goal): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = existingGoal.title;
	let cwdValue = existingGoal.cwd;
	let specValue = existingGoal.spec;
	let stateValue: GoalState = existingGoal.state;
	let saving = false;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doSave = async () => {
		const trimmedTitle = titleValue.trim();
		if (!trimmedTitle) return;
		saving = true;
		renderDialog();

		await updateGoal(existingGoal.id, {
			title: trimmedTitle,
			cwd: cwdValue.trim() || undefined,
			state: stateValue,
			spec: specValue,
		});
		saving = false;
		cleanup();
	};

	const renderDialog = () => {
		const stateOptions = (["todo", "in-progress", "complete", "shelved"] as GoalState[]).map(
			(s) => ({ value: s, label: GOAL_STATE_LABELS[s] }),
		);

		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(540px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Edit Goal" })}
							<div class="mt-4 flex flex-col gap-4">
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Title</label>
									${Input({
										type: "text",
										value: titleValue,
										onInput: (e: Event) => { titleValue = (e.target as HTMLInputElement).value; renderDialog(); },
										onKeyDown: (e: KeyboardEvent) => {
											if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSave(); }
											if (e.key === "Escape") cleanup();
										},
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Working Directory</label>
									${Input({
										type: "text",
										placeholder: "/path/to/project",
										value: cwdValue,
										onInput: (e: Event) => { cwdValue = (e.target as HTMLInputElement).value; },
									})}
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">State</label>
									<div class="flex gap-1.5">
										${stateOptions.map((opt) => html`
											<button
												class="px-3 py-1.5 text-xs rounded-md border transition-colors
													${stateValue === opt.value
														? "border-primary bg-primary/10 text-primary font-medium"
														: "border-border text-muted-foreground hover:bg-secondary"}"
												@click=${() => { stateValue = opt.value as GoalState; renderDialog(); }}
											>${opt.label}</button>
										`)}
									</div>
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Goal Spec (Markdown)</label>
									<textarea
										class="w-full min-h-[120px] max-h-[300px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
										placeholder="Describe the goal, acceptance criteria, constraints..."
										.value=${specValue}
										@input=${(e: Event) => { specValue = (e.target as HTMLTextAreaElement).value; }}
									></textarea>
									<p class="text-[10px] text-muted-foreground mt-1">Injected into the context window of all sessions under this goal.</p>
								</div>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({
									variant: "default",
									onClick: doSave,
									disabled: !titleValue.trim() || saving,
									children: saving ? "Saving…" : "Save",
								})}
							</div>
						`,
					})}
				`,
			}),
			container,
		);

		requestAnimationFrame(() => {
			const input = container.querySelector("input");
			if (input) { input.focus(); input.select(); }
		});
	};

	renderDialog();
}

// ============================================================================
// RENDER HELPERS
// ============================================================================

// ── Rich sidebar tooltip ───────────────────────────────────────────
let _tooltipEl: HTMLDivElement | null = null;
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;

function getTooltipEl(): HTMLDivElement {
	if (!_tooltipEl) {
		_tooltipEl = document.createElement("div");
		_tooltipEl.className = "sidebar-tooltip";
		document.body.appendChild(_tooltipEl);
	}
	return _tooltipEl;
}

function showSessionTooltip(e: MouseEvent, session: GatewaySession, displayTitle: string): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	const el = getTooltipEl();
	el.innerHTML = `
		<div class="tt-title">${escapeHtml(displayTitle)}</div>
		<div class="tt-cwd">${escapeHtml(session.cwd)}</div>
		<div class="tt-meta">${escapeHtml(formatSessionAge(session.lastActivity))}</div>
	`;
	// Position to the right of the hovered element
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	el.style.left = `${rect.right + 8}px`;
	el.style.top = `${rect.top + rect.height / 2}px`;
	el.style.transform = "translateY(-50%)";
	el.classList.add("visible");
}

function hideSessionTooltip(): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	_tooltipTimer = setTimeout(() => {
		getTooltipEl().classList.remove("visible");
	}, 80);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Show the last 3 segments of a path, e.g. "Users/joe/project" */
function shortenPath(fullPath: string): string {
	const parts = fullPath.split(/[/\\]/).filter(Boolean);
	if (parts.length <= 3) return parts.join("/");
	return "…/" + parts.slice(-3).join("/");
}

function formatSessionAge(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "";
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/**
 * Aurora Borealis palette — 20 curated hue-rotate offsets from canonical green (90°).
 * Flows from greens → teals → blues → purples → pinks and back.
 */
const BOBBIT_HUE_ROTATIONS = [
	0, 25, 50, 75, 100, 125, 150, 175, 200, 225,
	-135, -110, -85, -60, -35, -10, 15, 40, 65, 250,
];

/** Map of session ID → assigned palette index, loaded from server */
const sessionColorMap = new Map<string, number>();

/** Track which palette indices are in use so new sessions get the next unused one */
function nextAvailableColorIndex(): number {
	const used = new Set(sessionColorMap.values());
	for (let i = 0; i < BOBBIT_HUE_ROTATIONS.length; i++) {
		if (!used.has(i)) return i;
	}
	return sessionColorMap.size % BOBBIT_HUE_ROTATIONS.length;
}

/** Persist a session property update to the server via PATCH */
function patchSession(sessionId: string, updates: Record<string, unknown>): void {
	gatewayFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	}).catch(() => { /* best-effort */ });
}

/**
 * Get the hue-rotate offset for a session. Assigns colors from the Aurora
 * Borealis palette, persisted on the server for cross-device coherency.
 */
function sessionHueRotation(sessionId: string): number {
	let idx = sessionColorMap.get(sessionId);
	if (idx === undefined) {
		idx = nextAvailableColorIndex();
		sessionColorMap.set(sessionId, idx);
		patchSession(sessionId, { colorIndex: idx });
	}
	return BOBBIT_HUE_ROTATIONS[idx];
}

/** Change a session's color to a specific palette index */
function setSessionColor(sessionId: string, paletteIndex: number): void {
	sessionColorMap.set(sessionId, paletteIndex);
	patchSession(sessionId, { colorIndex: paletteIndex });
	if (activeSessionId() === sessionId) {
		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${BOBBIT_HUE_ROTATIONS[paletteIndex]}deg`);
	}
	renderApp();
}

/**
 * Generate a 3-letter uppercase acronym from a session title.
 * Takes first letters of the first 3 significant words.
 * Falls back to first 3 chars of the title if fewer words.
 */
function sessionAcronym(title: string): string {
	const stopWords = new Set(["the", "a", "an", "and", "or", "in", "on", "to", "of", "for", "with", "is", "it"]);
	const words = title.split(/[\s\-_/]+/).filter((w) => w.length > 0 && !stopWords.has(w.toLowerCase()));
	if (words.length >= 3) return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
	if (words.length === 2) return (words[0][0] + words[1][0] + (words[1][1] || "")).toUpperCase();
	if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
	return title.slice(0, 3).toUpperCase();
}

/**
 * Tiny static Bobbit pixel-art icon used as a session status indicator.
 * Same 10×9 pixel grid as the streaming blob, but scaled down and colored
 * per session status. No animation, no blinking — just a little Bobbit.
 *
 * When a sessionId is provided, the bobbit uses a unique color derived from it.
 * Otherwise falls back to the canonical green.
 */
function statusBobbit(status: string, isCompacting = false, sessionId?: string, isSelected = false) {
	// Hue rotation offset from canonical green
	const hueRotate = sessionId ? sessionHueRotation(sessionId) : 0;

	const canonical = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#1a3010" };
	let p: typeof canonical;
	if (status === "starting") {
		p = { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#2d2006" };
	} else if (status === "terminated") {
		p = { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#2c0b0e" };
	} else {
		p = canonical;
	}

	const isBusy = status === "streaming" || isCompacting;

	// Base sprite — eyes filled with main color when selected (eyes rendered as separate animated layer)
	const eyeColor = isSelected ? p.main : p.eye;
	const shadow = `
		3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,
		2px 1px 0 #000,3px 1px 0 ${p.main},4px 1px 0 ${p.main},5px 1px 0 ${p.main},6px 1px 0 ${p.light},7px 1px 0 ${p.light},8px 1px 0 #000,
		1px 2px 0 #000,2px 2px 0 ${p.main},3px 2px 0 ${p.main},4px 2px 0 ${p.main},5px 2px 0 ${p.main},6px 2px 0 ${p.main},7px 2px 0 ${p.light},8px 2px 0 ${p.main},9px 2px 0 #000,
		0px 3px 0 #000,1px 3px 0 ${p.main},2px 3px 0 ${p.main},3px 3px 0 ${p.main},4px 3px 0 ${p.main},5px 3px 0 ${p.main},6px 3px 0 ${p.main},7px 3px 0 ${p.main},8px 3px 0 ${p.main},9px 3px 0 #000,
		0px 4px 0 #000,1px 4px 0 ${p.main},2px 4px 0 ${p.main},3px 4px 0 ${eyeColor},4px 4px 0 ${p.main},5px 4px 0 ${p.main},6px 4px 0 ${eyeColor},7px 4px 0 ${p.main},8px 4px 0 ${p.main},9px 4px 0 #000,
		0px 5px 0 #000,1px 5px 0 ${p.main},2px 5px 0 ${p.main},3px 5px 0 ${eyeColor},4px 5px 0 ${p.main},5px 5px 0 ${p.main},6px 5px 0 ${eyeColor},7px 5px 0 ${p.main},8px 5px 0 ${p.main},9px 5px 0 #000,
		0px 6px 0 #000,1px 6px 0 ${p.dark},2px 6px 0 ${p.main},3px 6px 0 ${p.main},4px 6px 0 ${p.main},5px 6px 0 ${p.main},6px 6px 0 ${p.main},7px 6px 0 ${p.main},8px 6px 0 ${p.main},9px 6px 0 #000,
		1px 7px 0 #000,2px 7px 0 ${p.dark},3px 7px 0 ${p.main},4px 7px 0 ${p.main},5px 7px 0 ${p.main},6px 7px 0 ${p.main},7px 7px 0 ${p.main},8px 7px 0 #000,
		2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000
	`;

	// Eye overlay — only the 4 eye pixels, animated separately for active sessions
	const eyeShadow = `3px 4px 0 ${p.eye},6px 4px 0 ${p.eye},3px 5px 0 ${p.eye},6px 5px 0 ${p.eye}`;

	const shimmerDelay = -(Date.now() % 8000);
	const shimmer = isBusy ? `animation:blob-shimmer 8s ease-in-out infinite;animation-delay:${shimmerDelay}ms;` : "";
	// Filters: hue-rotate for session color, slight desaturation for idle non-selected
	const isIdle = status === "idle" && !isCompacting && !isSelected;
	const filters: string[] = [];
	if (hueRotate && status !== "starting" && status !== "terminated") filters.push(`hue-rotate(${hueRotate}deg)`);
	if (isIdle) filters.push("saturate(0.55)");
	const filterStyle = filters.length ? `filter:${filters.join(" ")};` : "";
	// Bobbing animation for any busy bobbit (doing work), eye animation for selected only
	const bobAnim = isBusy ? "animation:bobbit-bob 2.5s ease-in-out infinite;" : "";
	const baseTransform = isCompacting
		? "transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(4.5px);transform-origin:0 9px;"
		: "transform:scale(1.6);transform-origin:0 0;";
	const eyeAnim = isSelected
		? `animation:${isCompacting ? "bobbit-eyes-squash" : "bobbit-eyes"} 6s step-end infinite;transform-origin:0 ${isCompacting ? "9px" : "0"};`
		: baseTransform;

	const eyeLayer = isSelected
		? html`<span style="position:absolute;left:0;top:0;display:block;width:1px;height:1px;image-rendering:pixelated;box-shadow:${eyeShadow};${eyeAnim}"></span>`
		: "";

	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:15px;flex-shrink:0;position:relative;overflow:hidden;margin-top:2px;${filterStyle}${bobAnim}"><span style="position:absolute;left:0;top:0;display:block;width:1px;height:1px;image-rendering:pixelated;${baseTransform}box-shadow:${shadow};${shimmer}"></span>${eyeLayer}</span>`;
}

/** Show a rename dialog for a session */
function showRenameDialog(sessionId: string, currentTitle: string): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = currentTitle;
	let generating = false;
	let titleChangeUnsub: (() => void) | null = null;

	const cleanup = () => {
		titleChangeUnsub?.();
		titleChangeUnsub = null;
		render(html``, container);
		container.remove();
	};

	const doRename = () => {
		const trimmed = titleValue.trim();
		if (!trimmed || trimmed === currentTitle) {
			cleanup();
			return;
		}
		// Optimistically update the local sidebar data so the title survives
		// even if the user navigates away before the server round-trip completes.
		updateLocalSessionTitle(sessionId, trimmed);

		// If this is the active session, use the RemoteAgent to rename (updates server + broadcasts)
		if (remoteAgent && activeSessionId() === sessionId) {
			remoteAgent.setTitle(trimmed);
		} else {
			// For non-active sessions, use PATCH to set title
			patchSession(sessionId, { title: trimmed });
			refreshSessions();
		}
		cleanup();
	};

	const doGenerate = () => {
		if (!remoteAgent || activeSessionId() !== sessionId) return;
		generating = true;
		renderDialog();

		// Listen for the title change event (one-shot)
		titleChangeUnsub?.();
		const prevOnTitle = remoteAgent.onTitleChange;
		remoteAgent.onTitleChange = (newTitle: string) => {
			// Restore original callback
			if (remoteAgent) remoteAgent.onTitleChange = prevOnTitle;
			titleChangeUnsub = null;
			titleValue = newTitle;
			generating = false;
			renderDialog();
			// Also fire the original so sidebar updates
			prevOnTitle?.(newTitle);
		};
		titleChangeUnsub = () => {
			if (remoteAgent) remoteAgent.onTitleChange = prevOnTitle;
		};

		// Add a timeout so the spinner doesn't spin forever
		setTimeout(() => {
			if (generating) {
				generating = false;
				titleChangeUnsub?.();
				titleChangeUnsub = null;
				renderDialog();
			}
		}, 15_000);

		remoteAgent.generateTitle();
	};

	const renderDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: cleanup,
				width: "min(420px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Rename Session" })}
							<div class="mt-4 flex flex-col gap-3">
								<div class="flex items-center gap-2">
									<div class="flex-1">
										${Input({
											value: titleValue,
											placeholder: "Session title…",
											onInput: (e: Event) => {
												titleValue = (e.target as HTMLInputElement).value;
											},
											onKeyDown: (e: KeyboardEvent) => {
												if (e.key === "Enter") doRename();
												if (e.key === "Escape") cleanup();
											},
										})}
									</div>
									${activeSessionId() === sessionId && remoteAgent
										? html`<button
												class="shrink-0 p-2 rounded-md border border-border hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
												@click=${doGenerate}
												?disabled=${generating}
												title="Auto-generate title from chat history"
											>
												${generating
													? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
															<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
														</svg>`
													: icon(WandSparkles, "sm")}
											</button>`
										: ""}
								</div>
								<!-- Bobbit color picker -->
								<div>
									<div class="text-xs text-muted-foreground mb-1.5">Colour</div>
									<div class="flex flex-wrap gap-1.5">
										${BOBBIT_HUE_ROTATIONS.map((rot, i) => {
											const isSelected = (sessionColorMap.get(sessionId) ?? -1) === i;
											return html`
												<button
													class="w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center ${isSelected ? "border-foreground scale-110" : "border-transparent hover:border-muted-foreground/50"}"
													style="position:relative;overflow:hidden;"
													title="Colour ${i + 1}"
													@click=${() => { setSessionColor(sessionId, i); renderDialog(); }}
												>
													<span style="position:absolute;left:1px;top:1px;display:block;width:1px;height:1px;image-rendering:pixelated;transform:scale(2.2);transform-origin:0 0;filter:hue-rotate(${rot}deg);box-shadow:3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,2px 1px 0 #000,3px 1px 0 #8ec63f,4px 1px 0 #8ec63f,5px 1px 0 #8ec63f,6px 1px 0 #b5d98a,7px 1px 0 #b5d98a,8px 1px 0 #000,1px 2px 0 #000,2px 2px 0 #8ec63f,3px 2px 0 #8ec63f,4px 2px 0 #8ec63f,5px 2px 0 #8ec63f,6px 2px 0 #8ec63f,7px 2px 0 #b5d98a,8px 2px 0 #8ec63f,9px 2px 0 #000,0px 3px 0 #000,1px 3px 0 #8ec63f,2px 3px 0 #8ec63f,3px 3px 0 #8ec63f,4px 3px 0 #8ec63f,5px 3px 0 #8ec63f,6px 3px 0 #8ec63f,7px 3px 0 #8ec63f,8px 3px 0 #8ec63f,9px 3px 0 #000,0px 4px 0 #000,1px 4px 0 #8ec63f,2px 4px 0 #8ec63f,3px 4px 0 #1a3010,4px 4px 0 #8ec63f,5px 4px 0 #8ec63f,6px 4px 0 #1a3010,7px 4px 0 #8ec63f,8px 4px 0 #8ec63f,9px 4px 0 #000,0px 5px 0 #000,1px 5px 0 #8ec63f,2px 5px 0 #8ec63f,3px 5px 0 #1a3010,4px 5px 0 #8ec63f,5px 5px 0 #8ec63f,6px 5px 0 #1a3010,7px 5px 0 #8ec63f,8px 5px 0 #8ec63f,9px 5px 0 #000,0px 6px 0 #000,1px 6px 0 #6b9930,2px 6px 0 #8ec63f,3px 6px 0 #8ec63f,4px 6px 0 #8ec63f,5px 6px 0 #8ec63f,6px 6px 0 #8ec63f,7px 6px 0 #8ec63f,8px 6px 0 #8ec63f,9px 6px 0 #000,1px 7px 0 #000,2px 7px 0 #6b9930,3px 7px 0 #8ec63f,4px 7px 0 #8ec63f,5px 7px 0 #8ec63f,6px 7px 0 #8ec63f,7px 7px 0 #8ec63f,8px 7px 0 #000,2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000;"></span>
												</button>
											`;
										})}
									</div>
								</div>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({ onClick: doRename, children: "Rename" })}
							</div>
						`,
					})}
				`,
			}),
			container,
		);

		// Focus the input after render
		requestAnimationFrame(() => {
			const input = container.querySelector("input");
			if (input) {
				input.focus();
				input.select();
			}
		});
	};

	renderDialog();
}

/** Session row padding — shared between collapsed and expanded */
const SESSION_ROW_PY = "py-0.5";

/** Compact session row for sidebar */
function renderSidebarSession(session: GatewaySession) {
	const active = activeSessionId() === session.id;
	const connecting = connectingSessionId === session.id;
	const displayTitle = active && remoteAgent ? remoteAgent.title : session.title;
	return html`
		<div
			class="group relative flex items-center gap-1 pl-3 pr-1 ${SESSION_ROW_PY} rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, session, displayTitle)}
			@mouseleave=${hideSessionTooltip}
			@click=${() => {
				if (!active && !connecting) connectToSession(session.id, true);
			}}
		>
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active)}
			</div>
			<div class="flex-1 min-w-0 truncate text-xs ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"}">
				${displayTitle}
			</div>
			<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
				<button
					class="p-0.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
					@click=${(e: Event) => {
						e.stopPropagation();
						showRenameDialog(session.id, displayTitle);
					}}
					title="Rename"
				>
					${icon(Pencil, "xs")}
				</button>
				<button
					class="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
					@click=${(e: Event) => {
						e.stopPropagation();
						terminateSession(session.id);
					}}
					title="Terminate"
				>
					${icon(Trash2, "xs")}
				</button>
			</div>
		</div>
	`;
}

/** Full-size session card for mobile landing page */
function renderSessionCard(session: GatewaySession, index = 0) {
	const active = activeSessionId() === session.id;
	const connecting = connectingSessionId === session.id;
	return html`
		<div
			class="group session-card-enter flex items-center gap-4 p-4 rounded-lg border ${connecting ? "border-primary/40 bg-secondary/30" : "border-border hover:border-foreground/20 hover:bg-secondary/50"} cursor-pointer transition-all"
			style="animation-delay: ${index * 50}ms"
			@click=${() => { if (!connecting) connectToSession(session.id, true); }}
		>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-1">
					${connecting
						? html`<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
						: statusBobbit(session.status, session.isCompacting, session.id, active)}
					<span class="text-sm ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"} text-foreground">${session.title}</span>
					<span class="text-xs text-muted-foreground">·</span>
					<span class="text-xs text-muted-foreground">${formatSessionAge(session.lastActivity)}</span>
				</div>
				<div class="text-xs text-muted-foreground font-mono truncate" title=${session.cwd}>${session.cwd}</div>
				<div class="mt-1.5 text-xs text-muted-foreground">
					<span class="font-mono text-[10px] opacity-60" title=${session.id}>${session.id.slice(0, 8)}…</span>
				</div>
			</div>
			<div class="flex flex-col gap-1 shrink-0">
				<button
					class="p-2 rounded-md hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-all"
					@click=${(e: Event) => {
						e.stopPropagation();
						showRenameDialog(session.id, session.title);
					}}
					title="Rename session"
				>
					${icon(Pencil, "sm")}
				</button>
				<button
					class="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
					@click=${(e: Event) => {
						e.stopPropagation();
						terminateSession(session.id);
					}}
					title="Terminate session"
				>
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

// ============================================================================
// SIDEBAR (desktop only, when authenticated)
// ============================================================================

/**
 * Reticle icon for goal state — matches the Crosshair (lucide) shape:
 * circle at r=10 with four lines extending outward from the circle edge.
 * Color indicates state:
 * - todo: all grey
 * - in-progress: clockwise fill from 12→8 (240°) in blue, rest grey
 * - complete: all green
 * - shelved: all grey, dimmed
 */
function goalStateIcon(state: GoalState, size = 14) {
	const C = 2 * Math.PI * 10; // circumference ≈ 62.83
	const blue = "#3b82f6";
	const green = "#22c55e";

	const grey = "#6b7280";

	let circleContent: ReturnType<typeof svg>;
	if (state === "complete") {
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${green}" stroke-width="2"/>`;
	} else if (state === "in-progress") {
		const progress = (240 / 360) * C;
		circleContent = svg`
			<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="0.4"/>
			<circle cx="12" cy="12" r="10" fill="none" stroke="${blue}" stroke-width="2"
				stroke-dasharray="${progress} ${C}"
				stroke-dashoffset="0"
				transform="rotate(-90 12 12)"/>
		`;
	} else {
		const opacity = state === "shelved" ? "0.3" : "0.5";
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="${opacity}"/>`;
	}

	const lineColor = state === "complete" ? green : state === "in-progress" ? blue : grey;
	const lineOpacity = state === "shelved" ? "0.3" : state === "todo" ? "0.5" : "1";

	// Lines extend from outside the circle inward (22→18, 6→2) — same as lucide Crosshair
	return html`
		<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="display:block;flex-shrink:0;">
			${circleContent}
			${svg`<line x1="22" x2="18" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="6" x2="2" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="6" y2="2" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="22" y2="18" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
		</svg>
	`;
}

function renderSidebarGoal(goal: Goal) {
	const isExpanded = expandedGoals.has(goal.id);
	const goalSessions = gatewaySessions.filter((s) => s.goalId === goal.id);
	const hasActiveSessions = goalSessions.some((s) => s.status === "streaming");
	const isCreatingHere = creatingSessionForGoalId === goal.id;

	return html`
		<div class="flex flex-col gap-0.5">
			<!-- Goal header -->
			<div class="group relative flex items-center gap-1 px-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/50 transition-colors"
				@click=${() => { if (isExpanded) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}>
				<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${isExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0" title="${GOAL_STATE_LABELS[goal.state]}">${goalStateIcon(goal.state, 12)}</span>
				<span class="flex-1 min-w-0 truncate text-xs font-medium text-foreground ${goal.state === "shelved" ? "opacity-60" : ""}" style="line-height:12px;transform:translateY(-1px)">${goal.title}</span>
				<!-- Goal actions (overlay on hover) -->
				<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
					<button class="p-0.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
						@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(goal.id); }}
						title="New session">
						${icon(Plus, "xs")}
					</button>
					<button class="p-0.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
						@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(goal); }}
						title="Edit goal">
						${icon(Pencil, "xs")}
					</button>
					<button class="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
						@click=${(e: Event) => { e.stopPropagation(); deleteGoal(goal.id); }}
						title="Delete goal">
						${icon(Trash2, "xs")}
					</button>
				</div>
			</div>
			<!-- Goal sessions (if expanded) -->
			${isExpanded ? html`
				<div class="flex flex-col gap-0.5">
					${goalSessions.length === 0 && !isCreatingHere
						? html`<div class="pl-3 py-1 text-[10px] text-muted-foreground">
								No sessions —
								<button class="text-primary hover:underline" @click=${() => createAndConnectSession(goal.id)}>start one</button>
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

function toggleSidebar() {
	sidebarCollapsed = !sidebarCollapsed;
	localStorage.setItem("bobbit-sidebar-collapsed", String(sidebarCollapsed));
	renderApp();
}

function renderSidebar() {
	const ungroupedSessions = gatewaySessions.filter((s) => !s.goalId);
	// Sort goals: in-progress first, then todo, then complete/shelved
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

	if (sidebarCollapsed) {
		const allSessions = gatewaySessions;
		const ungrouped = allSessions.filter((s) => !s.goalId);

		const renderCollapsedSession = (s: GatewaySession) => {
			const active = activeSessionId() === s.id;
			const displayTitle = active && remoteAgent ? remoteAgent.title : s.title;
			return html`
				<button
					class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary" : "hover:bg-secondary/50"}"
					@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, s, displayTitle)}
					@mouseleave=${hideSessionTooltip}
					@click=${() => { if (!active) connectToSession(s.id, true); }}
				>
					${statusBobbit(s.status, s.isCompacting, s.id, active)}
					<span class="text-[8px] font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1;">${sessionAcronym(displayTitle)}</span>
				</button>
			`;
		};

		return html`
			<div class="w-14 shrink-0 h-full flex flex-col items-center" style="background: var(--sidebar);">
				<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
					${sortedGoals.map((goal, i) => {
						const goalSessions = allSessions.filter((s) => s.goalId === goal.id);
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
					${ungrouped.length > 0 && sortedGoals.length > 0 ? html`
						<div class="w-7 border-t border-border/50 my-1.5"></div>
						<button
							class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
							title="Ungrouped sessions"
							@click=${() => { ungroupedExpanded = !ungroupedExpanded; saveUngroupedExpanded(); renderApp(); }}
						>
							<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${ungroupedExpanded ? "▾" : "▸"}</span>
							<span class="text-[10px] font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1;">SES</span>
						</button>
						${ungroupedExpanded ? ungrouped.map(renderCollapsedSession) : ""}
					` : sortedGoals.length === 0 ? ungrouped.map(renderCollapsedSession) : ""}
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

	return html`
		<div class="w-[240px] shrink-0 h-full flex flex-col" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 py-2 px-0.5">
				${sessionsLoading
					? html`<div class="text-center py-6 text-muted-foreground text-xs">Loading…</div>`
					: sessionsError
						? html`<div class="text-center py-6">
								<p class="text-xs text-red-500 mb-2">${sessionsError}</p>
								<button class="text-xs text-muted-foreground hover:text-foreground underline" @click=${refreshSessions}>Retry</button>
							</div>`
						: html`
							<!-- Goals -->
							${sortedGoals.map((goal, i) => html`
								${i > 0 ? html`<div class="border-t border-border/50 my-1.5 mx-1"></div>` : ""}
								${renderSidebarGoal(goal)}
							`)}

							<!-- Ungrouped sessions -->
							${ungroupedSessions.length > 0 && sortedGoals.length > 0 ? html`
								<div class="border-t border-border/50 my-1.5 mx-1"></div>
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:bg-secondary/30 rounded-md transition-colors"
										@click=${() => { ungroupedExpanded = !ungroupedExpanded; saveUngroupedExpanded(); renderApp(); }}>
										<span class="text-[11px] text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;">${ungroupedExpanded ? "▾" : "▸"}</span>
										<span class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
									</div>
									${ungroupedExpanded ? ungroupedSessions.map(renderSidebarSession) : ""}
								</div>
							` : sortedGoals.length === 0 ? html`
								<!-- No goals, just show sessions flat -->
								${ungroupedSessions.length === 0
									? html`<div class="text-center py-6">
											<p class="text-xs text-muted-foreground mb-2">No sessions</p>
											<button class="text-xs text-primary hover:underline" @click=${() => createAndConnectSession()}>Create one</button>
										</div>`
									: html`<div class="flex flex-col gap-0.5">${ungroupedSessions.map(renderSidebarSession)}</div>`}
							` : ""}
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
// MOBILE LANDING PAGE (small screens, when authenticated but no active session)
// ============================================================================

function renderMobileGoalCard(goal: Goal) {
	const goalSessions = gatewaySessions.filter((s) => s.goalId === goal.id);
	return html`
		<div class="rounded-lg border border-border p-4 ${goal.state === "shelved" ? "opacity-60" : ""}">
			<div class="flex items-center justify-between mb-2">
				<div class="flex items-center gap-2">
					<span class="shrink-0">${goalStateIcon(goal.state, 16)}</span>
					<span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">${goal.title}</span>
				</div>
				<div class="flex items-center gap-1">
					<button class="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
						@click=${() => showGoalDialog(goal)} title="Edit goal">
						${icon(Pencil, "sm")}
					</button>
					<button class="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
						@click=${() => deleteGoal(goal.id)} title="Delete goal">
						${icon(Trash2, "sm")}
					</button>
				</div>
			</div>
			<div class="text-xs text-muted-foreground font-mono truncate mb-2" title=${goal.cwd}>${goal.cwd}</div>
			<div class="flex items-center justify-between">
				<span class="text-xs px-2 py-0.5 rounded-full border border-border ${GOAL_STATE_COLORS[goal.state]}">${GOAL_STATE_LABELS[goal.state]}</span>
				${Button({
					variant: "ghost",
					size: "sm",
					onClick: () => createAndConnectSession(goal.id),
					children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "xs")} Session</span>`,
				})}
			</div>
			${goalSessions.length > 0 ? html`
				<div class="mt-3 flex flex-col gap-1.5">
					${goalSessions.map((s, i) => renderSessionCard(s, i))}
				</div>
			` : ""}
		</div>
	`;
}

function renderMobileLanding() {
	const ungroupedSessions = gatewaySessions.filter((s) => !s.goalId);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));

	return html`
		<div class="flex-1 flex flex-col items-center overflow-y-auto">
			<div class="w-full max-w-xl px-4 py-8 flex flex-col gap-6">
				<div class="flex items-center justify-between">
					<div>
						<h2 class="text-lg font-semibold text-foreground">Goals & Sessions</h2>
						<p class="text-sm text-muted-foreground mt-0.5">Organize work into goals, run sessions to make progress</p>
					</div>
					<div class="flex items-center gap-1.5">
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => showGoalDialog(),
							children: html`<span class="inline-flex items-center gap-1.5">${icon(Crosshair, "sm")} Goal</span>`,
						})}
						${Button({
							variant: "default",
							size: "sm",
							disabled: creatingSession,
							onClick: () => createAndConnectSession(),
							children: creatingSession && !creatingSessionForGoalId
								? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
								: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Session</span>`,
						})}
					</div>
				</div>

				${sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-sm">Loading…</div>`
					: sessionsError
						? html`<div class="text-center py-12">
								<p class="text-sm text-red-500 mb-3">${sessionsError}</p>
								${Button({ variant: "ghost", size: "sm", onClick: refreshSessions, children: "Retry" })}
							</div>`
						: goals.length === 0 && gatewaySessions.length === 0
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
											disabled: creatingSession,
											onClick: () => createAndConnectSession(),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Quick Session</span>`,
										})}
									</div>
								</div>`
							: html`
								<!-- Goals -->
								${sortedGoals.length > 0 ? html`
									<div class="flex flex-col gap-3">
										${sortedGoals.map(renderMobileGoalCard)}
									</div>
								` : ""}
								<!-- Ungrouped sessions -->
								${ungroupedSessions.length > 0 ? html`
									${sortedGoals.length > 0 ? html`<h3 class="text-sm font-medium text-muted-foreground mt-2">Ungrouped Sessions</h3>` : ""}
									<div class="flex flex-col gap-2">
										${ungroupedSessions.map((s, i) => renderSessionCard(s, i))}
									</div>
								` : ""}
							`}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	// Sync shimmer phase for chat blob — aligns with sidebar bobbits that compute the same value
	document.documentElement.style.setProperty("--bobbit-shimmer-delay", `${-(Date.now() % 8000)}ms`);

	// ── Disconnected state ──────────────────────────────────────────
	if (appView === "disconnected") {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
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

	// ── Authenticated state ─────────────────────────────────────────
	const desktop = isDesktop();
	const connected = hasActiveSession();

	// Header: model/thinking controls when connected
	const headerLeft = () => {
		if (connected && remoteAgent) {
			const model = remoteAgent.state.model;
			const supportsThinking = model?.reasoning === true;

			// On mobile, show back button to return to session list
			const backBtn = !desktop ? Button({
				variant: "ghost",
				size: "sm",
				children: html`<span class="inline-flex items-center gap-1.5">${icon(ArrowLeft, "sm")} <span class="text-xs">All Sessions</span></span>`,
				onClick: backToSessions,
				title: "Back to session list",
				className: "h-10 pl-3 pr-3",
			}) : "";

			const sessionTitle = remoteAgent.title || "New session";

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
				// Mobile: back left, title centered, edit/delete right
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

		// Not connected to a session
		if (!desktop) {
			return html`<div class="flex items-center gap-2 px-4 py-1">
				<span class="text-base font-semibold text-foreground">Bobbit</span>
			</div>`;
		}
		// Desktop: no session active — title is already in the unified bar
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
		// Mobile: no right buttons when in a session
		if (connected && remoteAgent) {
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
		if (!connected || connectionStatus === "connected") return "";
		return html`
			<div class="reconnect-banner shrink-0 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium
				${connectionStatus === "reconnecting"
					? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
					: "bg-red-500/15 text-red-700 dark:text-red-400"}">
				${connectionStatus === "reconnecting"
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
		// Don't show the banner in goal assistant sessions — they have the split-screen preview
		if (isGoalAssistantSession) return "";
		if (!activeGoalProposal || !connected) return "";
		const p = activeGoalProposal;
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
							onClick: () => {
								// Open edit dialog pre-filled with the proposal, then terminate assistant session
								showGoalEditDialogFromProposal(p);
							},
							children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "sm")} Edit</span>`,
						})}
						${Button({
							variant: "default",
							size: "sm",
							onClick: async () => {
								const sessionId = activeSessionId();
								await createGoal(p.title, p.cwd || "", p.spec);
								activeGoalProposal = null;
								// Terminate the assistant session
								if (sessionId) {
									await terminateSession(sessionId);
								}
							},
							children: html`<span class="inline-flex items-center gap-1">${icon(Crosshair, "sm")} Create Goal</span>`,
						})}
						${Button({
							variant: "ghost",
							size: "sm",
							onClick: () => { activeGoalProposal = null; renderApp(); },
							children: "Dismiss",
						})}
					</div>
				</div>
			</div>
		`;
	};

	/** Goal preview panel — shown in split-screen (desktop) or as a tab (mobile) */
	const goalPreviewPanel = () => {
		const handleCreateGoal = async () => {
			const trimmedTitle = previewTitle.trim();
			if (!trimmedTitle) return;
			const sessionId = activeSessionId();
			// Disconnect and clean up before creating the goal
			if (remoteAgent) {
				remoteAgent.disconnect();
				remoteAgent = null;
				connectionStatus = "disconnected";
			}
			isGoalAssistantSession = false;
			activeGoalProposal = null;
			localStorage.removeItem(GW_SESSION_KEY);
			setHashRoute("landing");
			appView = "authenticated";

			await createGoal(trimmedTitle, previewCwd.trim(), previewSpec);
			// Silently terminate the assistant session (no confirmation dialog)
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

		if (!hasReceivedProposal) {
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
					<!-- Title -->
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Title</label>
						${Input({
							type: "text",
							value: previewTitle,
							placeholder: "Goal title",
							onInput: (e: Event) => {
								previewTitle = (e.target as HTMLInputElement).value;
								previewTitleEdited = true;
							},
						})}
					</div>

					<!-- Working Directory -->
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
						${Input({
							type: "text",
							value: previewCwd,
							placeholder: "(server default)",
							onInput: (e: Event) => {
								previewCwd = (e.target as HTMLInputElement).value;
								previewCwdEdited = true;
							},
						})}
					</div>

					<!-- Spec -->
					<div class="flex-1 flex flex-col min-h-0">
						<div class="flex items-center justify-between mb-1.5">
							<label class="text-xs text-muted-foreground font-medium">Spec</label>
							<button
								class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
								@click=${() => { previewSpecEditMode = !previewSpecEditMode; renderApp(); }}
							>
								${previewSpecEditMode ? "Preview" : "Edit"}
							</button>
						</div>
						${previewSpecEditMode
							? html`<textarea
									class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
									.value=${previewSpec}
									@input=${(e: Event) => {
										previewSpec = (e.target as HTMLTextAreaElement).value;
										previewSpecEdited = true;
									}}
								></textarea>`
							: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
									<markdown-block .content=${previewSpec || "_No spec content yet_"}></markdown-block>
								</div>`
						}
					</div>
				</div>

				<!-- Action buttons -->
				<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
					${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
					${Button({
						variant: "default",
						onClick: handleCreateGoal,
						disabled: !previewTitle.trim(),
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Crosshair, "sm")} Create Goal</span>`,
					})}
				</div>
			</div>
		`;
	};

	/** Goal assistant mobile tab bar */
	const goalAssistantTabBar = () => {
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${goalAssistantTab === "chat" ? "goal-tab-pill--active" : ""}"
					@click=${() => { goalAssistantTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${goalAssistantTab === "preview" ? "goal-tab-pill--active" : ""}"
					@click=${() => { goalAssistantTab = "preview"; renderApp(); }}
				>
					Preview${hasReceivedProposal ? html` <span class="goal-tab-dot"></span>` : ""}
				</button>
			</div>
		`;
	};

	const mainArea = () => {
		if (connected && isGoalAssistantSession) {
			// Goal assistant: split-screen (desktop) or tabbed (mobile)
			if (desktop) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0">
						<div class="flex-1 min-w-0 flex flex-col">${chatPanel}</div>
						${goalPreviewPanel()}
					</div>
				`;
			}
			// Mobile: tabbed view
			return html`
				${reconnectBanner()}
				${goalAssistantTabBar()}
				${goalAssistantTab === "chat"
					? html`<div class="flex-1 min-h-0 flex flex-col">${chatPanel}</div>`
					: html`<div class="flex-1 min-h-0 flex flex-col">${goalPreviewPanel()}</div>`
				}
			`;
		}
		if (connected) return html`${reconnectBanner()}${goalProposalBanner()}${chatPanel}`;

		// No active session — empty state (desktop) or landing page (mobile)
		if (desktop) {
			return html`
				<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
					<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
					<p class="text-sm text-muted-foreground">Select a session from the sidebar or create a new one</p>
					${Button({
						variant: "default",
						size: "sm",
						disabled: creatingSession,
						onClick: () => createAndConnectSession(),
						children: creatingSession
							? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
							: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} New Session</span>`,
					})}
				</div>
			`;
		}
		return renderMobileLanding();
	};

	if (desktop) {
		// Desktop layout: unified top bar spanning full width, then sidebar | main below
		teardownMobileScrollTracking();
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<!-- Unified top bar -->
				<div class="flex items-center border-b border-border shrink-0">
					<!-- Left zone: app title + new goal/session (above sidebar width) -->
					${sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center py-1.5" style="background: var(--sidebar);">
						<button
							class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
							@click=${toggleSidebar}
							title="Expand sidebar (Ctrl+[)"
						>
							${icon(PanelLeftOpen, "sm")}
						</button>
					</div>
					` : html`
					<div class="w-[240px] shrink-0 flex items-center justify-between px-3 py-1.5" style="background: var(--sidebar);">
						<span class="text-base font-semibold text-foreground">Bobbit</span>
						<div class="flex items-center gap-0.5">
							<button
								class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
								@click=${() => showGoalDialog()}
								title="New goal"
							>
								${icon(Crosshair, "sm")}
							</button>
							<button
								class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${creatingSession ? "opacity-50 pointer-events-none" : ""}"
								@click=${() => createAndConnectSession()}
								title="New session"
								?disabled=${creatingSession}
							>
								${creatingSession && !creatingSessionForGoalId
									? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
									: icon(Plus, "sm")}
							</button>
						</div>
					</div>
					`}
					<!-- Center zone: session controls -->
					<div class="flex-1 flex items-center justify-between min-w-0">
						${headerLeft()}
						${headerRight()}
					</div>
				</div>
				<!-- Content area: sidebar + main -->
				<div class="flex-1 flex min-h-0">
					${renderSidebar()}
					<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
				</div>
			</div>
		`, app);
	} else if (connected) {
		// Mobile connected: floating header overlays content, auto-hides on
		// scroll-down and reappears on scroll-up.  A CSS rule adds extra
		// top-padding to the message area so the first message isn't hidden.
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden relative"
				data-mobile-header>
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border flex items-center justify-between"
					style="transform: translateY(${mobileHeaderVisible ? "0" : "-100%"}); transition: transform 200ms ease, box-shadow 200ms ease; will-change: transform;">
					${headerLeft()}
					${headerRight()}
				</div>
				<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
		// Set up scroll tracking (idempotent — won't recreate if already active)
		ensureMobileScrollTracking();
	} else {
		// Mobile not connected: normal static header
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
};

// ============================================================================
// INIT
// ============================================================================
// ============================================================================
// HASH CHANGE HANDLER (browser back/forward)
// ============================================================================

let handlingHashChange = false;

async function handleHashChange(): Promise<void> {
	if (handlingHashChange) return;
	handlingHashChange = true;

	try {
		const route = getRouteFromHash();
		const savedUrl = localStorage.getItem(GW_URL_KEY);
		const savedToken = localStorage.getItem(GW_TOKEN_KEY);

		if (!savedUrl || !savedToken) {
			appView = "disconnected";
			renderApp();
			return;
		}

		if (route.view === "session" && route.sessionId) {
			// If already connected to this session, nothing to do
			if (remoteAgent?.gatewaySessionId === route.sessionId) {
				return;
			}
			// Disconnect from current session if any
			if (remoteAgent) {
				remoteAgent.disconnect();
				remoteAgent = null;
				connectionStatus = "disconnected";
			}
			// Verify session still exists on the server
			const checkRes = await gatewayFetch(`/api/sessions/${route.sessionId}`);
			if (checkRes.ok) {
				await connectToSession(route.sessionId, true);
			} else {
				setHashRoute("landing");
				appView = "authenticated";
				renderApp();
				await refreshSessions();
			}
		} else {
			// No session in URL — disconnect from current session
			if (remoteAgent) {
				remoteAgent.disconnect();
				remoteAgent = null;
				connectionStatus = "disconnected";
			}
			appView = "authenticated";
			renderApp();
			await refreshSessions();
		}
	} finally {
		handlingHashChange = false;
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	chatPanel = new ChatPanel();

	// Check for token in URL (passed by gateway auto-open)
	const params = new URLSearchParams(window.location.search);
	const urlToken = params.get("token");
	if (urlToken) {
		localStorage.setItem(GW_URL_KEY, window.location.origin);
		localStorage.setItem(GW_TOKEN_KEY, urlToken);
		// Strip token from URL bar, keep the hash
		window.history.replaceState({}, "", window.location.pathname + window.location.hash);
	}

	const savedUrl = localStorage.getItem(GW_URL_KEY);
	const savedToken = localStorage.getItem(GW_TOKEN_KEY);

	renderApp();

	if (savedUrl && savedToken) {
		try {
			// Authenticate first (health + OAuth)
			await authenticateGateway(savedUrl, savedToken);

			// Now check if the URL has a session to reconnect to
			const route = getRouteFromHash();
			if (route.view === "session" && route.sessionId) {
				const checkRes = await gatewayFetch(`/api/sessions/${route.sessionId}`);
				if (checkRes.ok) {
					await connectToSession(route.sessionId, true);
				}
				// If session is gone, we're already on the landing page from authenticateGateway
			}
		} catch {
			renderApp();
		}
	}

	// Listen for browser back/forward navigation
	window.addEventListener("hashchange", handleHashChange);

	// Global keyboard shortcuts
	window.addEventListener("keydown", (e: KeyboardEvent) => {
		const mod = e.ctrlKey || e.metaKey;

		// Ctrl+T / Cmd+T — New session
		if (mod && e.key === "t") {
			if (appView === "authenticated") {
				e.preventDefault();
				createAndConnectSession();
			}
		}

		// Ctrl+/ / Cmd+/ — Focus message input
		if (mod && e.key === "/") {
			e.preventDefault();
			const textarea = document.querySelector("message-editor")?.querySelector("textarea");
			if (textarea) {
				textarea.focus();
			}
		}

		// Ctrl+[ / Cmd+[ — Toggle sidebar
		if (mod && e.key === "[") {
			e.preventDefault();
			sidebarCollapsed = !sidebarCollapsed;
			renderApp();
		}
	});
}

initApp();
