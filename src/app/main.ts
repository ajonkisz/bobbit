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
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "../ui/index.js";
import { html, render } from "lit";
import { KeyRound, QrCode, Server, Unplug } from "lucide";
import QRCode from "qrcode";
import "./app.css";
import { RemoteAgent } from "./remote-agent.js";

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
let isConnected = false;

const GW_URL_KEY = "gateway.url";
const GW_TOKEN_KEY = "gateway.token";
const GW_SESSION_KEY = "gateway.sessionId";

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
// GATEWAY CONNECTION
// ============================================================================
async function connectToGateway(url: string, token: string, existingSessionId?: string): Promise<void> {
	// Save credentials early so gatewayFetch() works for OAuth checks
	localStorage.setItem(GW_URL_KEY, url);
	localStorage.setItem(GW_TOKEN_KEY, token);

	// Verify gateway is reachable
	const healthRes = await fetch(`${url}/api/health`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!healthRes.ok) {
		if (healthRes.status === 401) throw new Error("Invalid auth token");
		throw new Error(`Gateway error: ${healthRes.status}`);
	}

	// Check OAuth BEFORE creating a session so the coding agent picks up credentials
	const hasAuth = await checkOAuthStatus();
	if (!hasAuth) {
		const success = await openOAuthDialog();
		if (!success) throw new Error("OAuth login required");
	}

	let sessionId = existingSessionId;

	// Try reconnecting to a saved session first
	if (sessionId) {
		const checkRes = await fetch(`${url}/api/sessions/${sessionId}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!checkRes.ok) {
			// Session is gone — fall through to create a new one
			sessionId = undefined;
		}
	}

	if (!sessionId) {
		// Create a new session
		const res = await fetch(`${url}/api/sessions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!res.ok) {
			throw new Error(`Session creation failed: ${res.status}`);
		}

		({ id: sessionId } = await res.json());
	}

	const remote = new RemoteAgent();
	await remote.connect(url, token, sessionId!);

	remoteAgent = remote;
	isConnected = true;
	localStorage.setItem(GW_SESSION_KEY, sessionId!);

	// Set a dummy API key so AgentInterface's key check doesn't block sending.
	// The real API key is on the gateway's coding agent, not in the browser.
	const modelProvider = remote.state.model?.provider || "anthropic";
	await storage.providerKeys.set(modelProvider, "gateway-managed");

	// Wire remote agent to ChatPanel (duck-typed Agent interface)
	await chatPanel.setAgent(remote as any, {
		// Always approve — keys are managed server-side
		onApiKeyRequired: async () => true,
	});

	// If reconnecting to an existing session, fetch the message history
	if (existingSessionId) {
		remote.requestMessages();
	}

	renderApp();
}

function disconnectGateway(): void {
	remoteAgent?.disconnect();
	remoteAgent = null;
	isConnected = false;
	localStorage.removeItem(GW_SESSION_KEY);
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
			await connectToGateway(urlValue.trim(), tokenValue.trim());
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
// RENDER
// ============================================================================
const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-4 py-1">
					<span class="text-base font-semibold text-foreground">Pi Gateway</span>
				</div>
				<div class="flex items-center gap-1 px-2">
					${isConnected
						? [Button({
								variant: "ghost",
								size: "sm",
								children: html`${icon(QrCode, "sm")}`,
								onClick: showQrCodeDialog,
								title: "Show QR code to continue on phone",
							}), Button({
								variant: "ghost",
								size: "sm",
								children: html`<span style="display:inline-flex;align-items:center;gap:6px">
									<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e"></span>
									<span class="text-xs">Connected</span>
								</span>`,
								onClick: disconnectGateway,
								title: "Disconnect from gateway",
							})]
						: Button({
								variant: "ghost",
								size: "sm",
								children: html`<span class="inline-flex items-center gap-1">
									${icon(Server, "sm")}
									<span class="text-xs">Connect</span>
								</span>`,
								onClick: openGatewayDialog,
								title: "Connect to gateway",
							})}
					<theme-toggle></theme-toggle>
				</div>
			</div>

			<!-- Main content -->
			${isConnected
				? chatPanel
				: html`
						<div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
							<div class="flex flex-col items-center gap-3 text-center">
								<div class="text-muted-foreground">${icon(Unplug, "lg")}</div>
								<h2 class="text-lg font-medium text-foreground">Not connected</h2>
								<p class="text-sm text-muted-foreground max-w-sm">
									Connect to a Pi Gateway to start working with the coding agent.
								</p>
							</div>
							${Button({
								variant: "default",
								onClick: openGatewayDialog,
								children: html`<span class="inline-flex items-center gap-2">
									${icon(Server, "sm")} Connect to Gateway
								</span>`,
							})}
						</div>
					`}
		</div>
	`;

	render(appHtml, app);
};

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
		// Strip token from URL bar so it's not visible or shared
		window.history.replaceState({}, "", window.location.pathname);
	}

	const savedUrl = localStorage.getItem(GW_URL_KEY);
	const savedToken = localStorage.getItem(GW_TOKEN_KEY);
	const savedSession = localStorage.getItem(GW_SESSION_KEY) || undefined;

	renderApp();

	if (savedUrl && savedToken) {
		try {
			await connectToGateway(savedUrl, savedToken, savedSession);
		} catch {
			renderApp();
		}
	}
}

initApp();
