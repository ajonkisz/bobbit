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
import { html, render } from "lit";
import { ArrowLeft, Brain, Pencil, Plus, QrCode, Server, Sparkles, Trash2, Unplug, Users, WandSparkles } from "lucide";
import QRCode from "qrcode";
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
}
let gatewaySessions: GatewaySession[] = [];
let sessionsLoading = false;
let sessionsError = "";
let creatingSession = false;
let connectingSessionId: string | null = null;
let sessionPollTimer: ReturnType<typeof setInterval> | null = null;

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
		const res = await gatewayFetch("/api/sessions");
		if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
		const data = await res.json();
		gatewaySessions = data.sessions || [];
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
async function connectToSession(sessionId: string, isExisting: boolean): Promise<void> {
	// Guard against concurrent connection attempts — if we're already
	// connecting to ANY session, bail out. This prevents parallel WebSocket
	// races when the user taps quickly on mobile.
	if (connectingSessionId) return;

	connectingSessionId = sessionId;
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
		connectionStatus = "connected";

		remoteAgent = remote;
		appView = "authenticated";
		localStorage.setItem(GW_SESSION_KEY, sessionId);
		setHashRoute("session", sessionId);

		const modelProvider = remote.state.model?.provider || "anthropic";
		await storage.providerKeys.set(modelProvider, "gateway-managed");

		// Create a fresh ChatPanel each time so old messages don't linger
		chatPanel = new ChatPanel();
		await chatPanel.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});

		// Model and thinking selectors are in the header bar, not the message editor
		if (chatPanel.agentInterface) {
			chatPanel.agentInterface.enableModelSelector = false;
			chatPanel.agentInterface.enableThinkingSelector = false;
		}

		if (isExisting) {
			remote.requestMessages();
		}

		// Focus the message input after rendering
		requestAnimationFrame(() => {
			const textarea = document.querySelector("message-editor")?.querySelector("textarea");
			if (textarea) textarea.focus();
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
async function createAndConnectSession(): Promise<void> {
	if (creatingSession) return;
	creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", { method: "POST" });
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		await connectToSession(id, false);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create session", msg);
	} finally {
		creatingSession = false;
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
// RENDER HELPERS
// ============================================================================

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
 * Tiny static Bobbit pixel-art icon used as a session status indicator.
 * Same 10×9 pixel grid as the streaming blob, but scaled down and colored
 * per session status. No animation, no blinking — just a little Bobbit.
 */
function statusBobbit(status: string, isCompacting = false) {
	// Streaming (busy) sessions get the canonical Bobbit green + shimmer.
	// Compacting sessions also get canonical green.
	// Idle sessions get a muted/desaturated green. Other states keep distinct colors.
	const canonical = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#1a3010" };
	const muted     = { main: "#8aaa6e", light: "#a8c094", dark: "#6e8c5a", eye: "#2a3a22" };
	const palettes: Record<string, { main: string; light: string; dark: string; eye: string }> = {
		idle:       muted,
		streaming:  canonical,
		starting:   { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#2d2006" },
		terminated: { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#2c0b0e" },
	};
	const p = isCompacting ? canonical : (palettes[status] || { main: "#6b7280", light: "#9ca3af", dark: "#4b5563", eye: "#1f2937" });
	const isBusy = status === "streaming" || isCompacting;
	// 10×9 pixel bobbit, same shape as the streaming sprite
	const shadow = `
		3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,
		2px 1px 0 #000,3px 1px 0 ${p.main},4px 1px 0 ${p.main},5px 1px 0 ${p.main},6px 1px 0 ${p.light},7px 1px 0 ${p.light},8px 1px 0 #000,
		1px 2px 0 #000,2px 2px 0 ${p.main},3px 2px 0 ${p.main},4px 2px 0 ${p.main},5px 2px 0 ${p.main},6px 2px 0 ${p.main},7px 2px 0 ${p.light},8px 2px 0 ${p.main},9px 2px 0 #000,
		0px 3px 0 #000,1px 3px 0 ${p.main},2px 3px 0 ${p.main},3px 3px 0 ${p.main},4px 3px 0 ${p.main},5px 3px 0 ${p.main},6px 3px 0 ${p.main},7px 3px 0 ${p.main},8px 3px 0 ${p.main},9px 3px 0 #000,
		0px 4px 0 #000,1px 4px 0 ${p.main},2px 4px 0 ${p.main},3px 4px 0 ${p.eye},4px 4px 0 ${p.main},5px 4px 0 ${p.main},6px 4px 0 ${p.eye},7px 4px 0 ${p.main},8px 4px 0 ${p.main},9px 4px 0 #000,
		0px 5px 0 #000,1px 5px 0 ${p.main},2px 5px 0 ${p.main},3px 5px 0 ${p.eye},4px 5px 0 ${p.main},5px 5px 0 ${p.main},6px 5px 0 ${p.eye},7px 5px 0 ${p.main},8px 5px 0 ${p.main},9px 5px 0 #000,
		0px 6px 0 #000,1px 6px 0 ${p.dark},2px 6px 0 ${p.main},3px 6px 0 ${p.main},4px 6px 0 ${p.main},5px 6px 0 ${p.main},6px 6px 0 ${p.main},7px 6px 0 ${p.main},8px 6px 0 ${p.main},9px 6px 0 #000,
		1px 7px 0 #000,2px 7px 0 ${p.dark},3px 7px 0 ${p.main},4px 7px 0 ${p.main},5px 7px 0 ${p.main},6px 7px 0 ${p.main},7px 7px 0 ${p.main},8px 7px 0 #000,
		2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000
	`;
	// Sprite pixels span x 0–9, y 0–8 (10×9). At scale 1.6 → 16×14.4px.
	// Outer span is sized to contain the scaled artwork so it participates
	// in flex layout correctly. Inner 1×1 element is scaled from top-left.
	const shimmer = isBusy ? "animation:blob-shimmer 8s ease-in-out infinite;" : "";
	const spriteTransform = isCompacting
		? "transform:scale(1.6) scaleX(1.25) scaleY(0.7);transform-origin:0 0;"
		: "transform:scale(1.6);transform-origin:0 0;";
	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:15px;flex-shrink:0;position:relative;overflow:hidden;margin-top:2px"><span style="position:absolute;left:0;top:0;display:block;width:1px;height:1px;image-rendering:pixelated;${spriteTransform}box-shadow:${shadow};${shimmer}"></span></span>`;
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
			// For non-active sessions, call the REST API to set title
			gatewayFetch(`/api/sessions/${sessionId}/title`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: trimmed }),
			}).then(() => refreshSessions());
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

/** Compact session row for sidebar */
function renderSidebarSession(session: GatewaySession) {
	const active = activeSessionId() === session.id;
	const connecting = connectingSessionId === session.id;
	// Use live title from RemoteAgent if this is the active session
	const displayTitle = active && remoteAgent ? remoteAgent.title : session.title;
	return html`
		<div
			class="group flex items-start gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			@click=${() => {
				if (!active && !connecting) connectToSession(session.id, true);
			}}
		>
			<div class="shrink-0 flex items-center justify-center w-6 self-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting)}
			</div>
			<div class="flex-1 min-w-0">
				<div class="truncate text-xs ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"}" title=${displayTitle}>
					${displayTitle}
				</div>
				<div class="text-[10px] opacity-60 font-mono truncate leading-tight" title=${session.cwd}>
					${shortenPath(session.cwd)}
				</div>
				<div class="text-[10px] opacity-60 mt-0.5">
					${formatSessionAge(session.lastActivity)}
				</div>
			</div>
			<div class="sm:opacity-0 sm:group-hover:opacity-100 flex flex-col gap-0.5 shrink-0 transition-opacity">
				<button
					class="p-1 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
					@click=${(e: Event) => {
						e.stopPropagation();
						showRenameDialog(session.id, displayTitle);
					}}
					title="Rename session"
				>
					${icon(Pencil, "xs")}
				</button>
				<button
					class="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
					@click=${(e: Event) => {
						e.stopPropagation();
						terminateSession(session.id);
					}}
					title="Terminate session"
				>
					${icon(Trash2, "xs")}
				</button>
			</div>
		</div>
	`;
}

/** Full-size session card for mobile landing page */
function renderSessionCard(session: GatewaySession, index = 0) {
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
						: statusBobbit(session.status, session.isCompacting)}
					<span class="text-sm ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"} text-foreground">${session.title}</span>
					<span class="text-xs text-muted-foreground">·</span>
					<span class="text-xs text-muted-foreground">${formatSessionAge(session.lastActivity)}</span>
				</div>
				<div class="text-xs text-muted-foreground font-mono truncate" title=${session.cwd}>${session.cwd}</div>
				<div class="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
					<span class="inline-flex items-center gap-1">${icon(Users, "xs")} ${session.clientCount} connected</span>
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

function renderSidebar() {
	return html`
		<div class="w-[240px] shrink-0 h-full flex flex-col" style="background: var(--sidebar);">
			<!-- Session list — starts immediately, no separate header -->
			<div class="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
				${sessionsLoading
					? html`<div class="text-center py-6 text-muted-foreground text-xs">Loading…</div>`
					: sessionsError
						? html`<div class="text-center py-6">
								<p class="text-xs text-red-500 mb-2">${sessionsError}</p>
								<button class="text-xs text-muted-foreground hover:text-foreground underline" @click=${refreshSessions}>Retry</button>
							</div>`
						: gatewaySessions.length === 0
							? html`<div class="text-center py-6">
									<p class="text-xs text-muted-foreground mb-2">No sessions</p>
									<button class="text-xs text-primary hover:underline" @click=${createAndConnectSession}>Create one</button>
								</div>`
							: gatewaySessions.map(renderSidebarSession)
				}
			</div>
		</div>
	`;
}

// ============================================================================
// MOBILE LANDING PAGE (small screens, when authenticated but no active session)
// ============================================================================

function renderMobileLanding() {
	return html`
		<div class="flex-1 flex flex-col items-center overflow-y-auto">
			<div class="w-full max-w-xl px-4 py-8 flex flex-col gap-6">
				<div class="flex items-center justify-between">
					<div>
						<h2 class="text-lg font-semibold text-foreground">Sessions</h2>
						<p class="text-sm text-muted-foreground mt-0.5">Connect to an existing session or start a new one</p>
					</div>
					${Button({
						variant: "default",
						size: "sm",
						disabled: creatingSession,
						onClick: createAndConnectSession,
						children: creatingSession
							? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
							: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} New Session</span>`,
					})}
				</div>

				${sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-sm">Loading sessions…</div>`
					: sessionsError
						? html`<div class="text-center py-12">
								<p class="text-sm text-red-500 mb-3">${sessionsError}</p>
								${Button({ variant: "ghost", size: "sm", onClick: refreshSessions, children: "Retry" })}
							</div>`
						: gatewaySessions.length === 0
							? html`<div class="text-center py-12">
									<div class="text-muted-foreground mb-3 empty-state-icon">${icon(Server, "lg")}</div>
									<p class="text-sm text-muted-foreground mb-4">No active sessions</p>
									${Button({
										variant: "default",
										disabled: creatingSession,
										onClick: createAndConnectSession,
										children: creatingSession
											? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
											: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Start a Session</span>`,
									})}
								</div>`
							: html`<div class="flex flex-col gap-2">
									${gatewaySessions.map((s, i) => renderSessionCard(s, i))}
								</div>`}
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
				children: html`<span class="inline-flex items-center gap-1">${icon(ArrowLeft, "sm")} <span class="text-xs">Sessions</span></span>`,
				onClick: backToSessions,
				title: "Back to session list",
			}) : "";

			const sessionTitle = remoteAgent.title || "New session";

			return html`
				<div class="flex items-center gap-1 px-2">
					${backBtn}
					<span class="text-sm font-medium text-foreground truncate max-w-[320px]" title=${sessionTitle}>${sessionTitle}</span>
					<span class="text-muted-foreground text-xs mx-1">·</span>
					${model ? Button({
						variant: "ghost",
						size: "sm",
						onClick: () => {
							ModelSelector.open(model, (m) => remoteAgent?.setModel(m));
						},
						children: html`<span class="inline-flex items-center gap-1">${icon(Sparkles, "sm")} <span class="text-xs">${model.id}</span></span>`,
						className: "h-8 text-xs truncate max-w-[200px]",
						title: "Change model",
					}) : ""}
					${supportsThinking ? Select({
						value: remoteAgent.state.thinkingLevel || "off",
						placeholder: "Off",
						options: [
							{ value: "off", label: "Off", icon: icon(Brain, "sm") },
							{ value: "minimal", label: "Minimal", icon: icon(Brain, "sm") },
							{ value: "low", label: "Low", icon: icon(Brain, "sm") },
							{ value: "medium", label: "Medium", icon: icon(Brain, "sm") },
							{ value: "high", label: "High", icon: icon(Brain, "sm") },
						] as SelectOption[],
						onChange: (value: string) => {
							remoteAgent?.setThinkingLevel(value as any);
							renderApp();
						},
						width: "80px",
						size: "sm",
						variant: "ghost",
						fitContent: true,
					}) : ""}
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
		// Mobile
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

	const mainArea = () => {
		if (connected) return html`${reconnectBanner()}${chatPanel}`;

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
						onClick: createAndConnectSession,
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
					<!-- Left zone: app title + new session (above sidebar width) -->
					<div class="w-[240px] shrink-0 flex items-center justify-between px-3 py-1.5" style="background: var(--sidebar);">
						<span class="text-base font-semibold text-foreground">Bobbit</span>
						<button
							class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${creatingSession ? "opacity-50 pointer-events-none" : ""}"
							@click=${createAndConnectSession}
							title="New session"
							?disabled=${creatingSession}
						>
							${creatingSession
								? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
								: icon(Plus, "sm")}
						</button>
					</div>
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
	});
}

initApp();
