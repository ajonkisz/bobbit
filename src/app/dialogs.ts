import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { WandSparkles } from "lucide";
import { cwdCombobox, worktreeToggle } from "./cwd-combobox.js";
import QRCode from "qrcode";
import {
	state,
	renderApp,
	activeSessionId,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GOAL_STATE_LABELS,
	type Goal,
	type GoalState,
} from "./state.js";
import { gatewayFetch, createGoal, updateGoal } from "./api.js";
import { updateLocalSessionTitle } from "./api.js";
import { refreshSessions } from "./api.js";
import { BOBBIT_HUE_ROTATIONS, sessionColorMap, setSessionColor, statusBobbit, getAccessory } from "./session-colors.js";
import { clearSessionModel } from "./routing.js";
// NOTE: session-manager imports from dialogs, so we use dynamic imports to break the cycle


// ============================================================================
// CONFIRM / ERROR DIALOGS
// ============================================================================

export function confirmAction(title: string, message: string, confirmLabel = "Confirm", destructive = false): Promise<boolean> {
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

export function showConnectionError(title: string, message: string): void {
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

// ============================================================================
// OAUTH DIALOG
// ============================================================================

export async function checkOAuthStatus(): Promise<boolean> {
	const res = await gatewayFetch("/api/oauth/status");
	if (!res.ok) return false;
	const data = await res.json();
	return data.authenticated === true;
}

export function openOAuthDialog(): Promise<boolean> {
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
// GATEWAY DIALOG
// ============================================================================

export function openGatewayDialog(): void {
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
			const { authenticateGateway } = await import("./session-manager.js");
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

export async function showQrCodeDialog(): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
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
// RENAME DIALOG
// ============================================================================

export function showRenameDialog(sessionId: string, currentTitle: string): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = currentTitle;
	let generating = false;
	let titleChangeUnsub: (() => void) | null = null;
	let roleDropdownOpen = false;

	// Load roles for the picker
	import("./api.js").then(({ fetchRoles }) => {
		if (state.roles.length === 0) fetchRoles().then(() => renderDialog());
	});

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
		updateLocalSessionTitle(sessionId, trimmed);

		if (state.remoteAgent && activeSessionId() === sessionId) {
			state.remoteAgent.setTitle(trimmed);
		} else {
			import("./api.js").then(({ patchSession }) => {
				patchSession(sessionId, { title: trimmed });
			});
			refreshSessions();
		}
		cleanup();
	};

	const doGenerate = () => {
		if (!state.remoteAgent || activeSessionId() !== sessionId) return;
		generating = true;
		renderDialog();

		titleChangeUnsub?.();
		const prevOnTitle = state.remoteAgent.onTitleChange;
		state.remoteAgent.onTitleChange = (newTitle: string) => {
			if (state.remoteAgent) state.remoteAgent.onTitleChange = prevOnTitle;
			titleChangeUnsub = null;
			titleValue = newTitle;
			generating = false;
			renderDialog();
			prevOnTitle?.(newTitle);
		};
		titleChangeUnsub = () => {
			if (state.remoteAgent) state.remoteAgent.onTitleChange = prevOnTitle;
		};

		setTimeout(() => {
			if (generating) {
				generating = false;
				titleChangeUnsub?.();
				titleChangeUnsub = null;
				renderDialog();
			}
		}, 15_000);

		state.remoteAgent.generateTitle();
	};

	const doAssignRole = async (roleName: string | null) => {
		roleDropdownOpen = false;
		renderDialog();
		try {
			await gatewayFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: roleName || "" }),
			});
			await refreshSessions();
			renderDialog();
		} catch (err) {
			console.error("[assign-role] Failed:", err);
		}
	};

	const renderDialog = () => {
		const session = state.gatewaySessions.find((s) => s.id === sessionId);
		const currentAccessory = session?.accessory
			?? (session?.role === "team-lead" ? "crown" : session?.role === "coder" ? "bandana" : "none");
		const acc = getAccessory(currentAccessory);
		const hasAccessory = acc.id !== "none" && acc.shadow !== "";

		// Split 14 colours into 2 equal rows of 7
		const ROW_SIZE = Math.ceil(BOBBIT_HUE_ROTATIONS.length / 2);

		const currentRole = session?.role || "";
		const currentRoleObj = state.roles.find((r) => r.name === currentRole);
		const roleLabel = session?.goalAssistant ? "Goal Assistant" : currentRoleObj?.label || currentRole || "None";

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
							${DialogHeader({ title: "Edit Session" })}
							<div class="mt-4 flex flex-col gap-4">
								<!-- Title -->
								<div>
									<div class="text-xs text-muted-foreground mb-1.5">Title</div>
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
										${activeSessionId() === sessionId && state.remoteAgent
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
								<!-- Colour picker -->
								<div>
									<div class="text-xs text-muted-foreground mb-2">Colour</div>
									<div class="flex flex-col gap-2">
										${[0, ROW_SIZE].map((start) => html`
											<div class="flex gap-2 justify-center">
												${BOBBIT_HUE_ROTATIONS.slice(start, start + ROW_SIZE).map((rot, j) => {
													const i = start + j;
													const isSelected = (sessionColorMap.get(sessionId) ?? -1) === i;
													const accShadow = hasAccessory ? acc.shadow : "";
													const accFilter = acc.id !== "flask" ? `filter:hue-rotate(${-rot}deg);` : "";
													// Bobbit sprite is 10 wide, accessory can extend to ~12. Centre within cell.
													// Cell: 28×24px, sprite scale 2.0, sprite is ~10×9 native = 20×18 scaled.
													// Centre offset: (28-20)/2=4 left, (24-18)/2=3 top
													return html`
														<button
															class="relative transition-all rounded-lg flex items-center justify-center
																${isSelected
																	? "ring-2 ring-primary ring-offset-1 ring-offset-background"
																	: "hover:bg-secondary/50"}"
															style="width:${hasAccessory ? 34 : 28}px;height:24px;"
															title="Colour ${i + 1}"
															@click=${() => { setSessionColor(sessionId, i); renderDialog(); }}
														>
															<span style="position:absolute;left:${hasAccessory ? 3 : 4}px;top:3px;display:block;width:1px;height:1px;image-rendering:pixelated;transform:scale(2);transform-origin:0 0;filter:hue-rotate(${rot}deg);box-shadow:3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,2px 1px 0 #000,3px 1px 0 #8ec63f,4px 1px 0 #8ec63f,5px 1px 0 #8ec63f,6px 1px 0 #b5d98a,7px 1px 0 #b5d98a,8px 1px 0 #000,1px 2px 0 #000,2px 2px 0 #8ec63f,3px 2px 0 #8ec63f,4px 2px 0 #8ec63f,5px 2px 0 #8ec63f,6px 2px 0 #8ec63f,7px 2px 0 #b5d98a,8px 2px 0 #8ec63f,9px 2px 0 #000,0px 3px 0 #000,1px 3px 0 #8ec63f,2px 3px 0 #8ec63f,3px 3px 0 #8ec63f,4px 3px 0 #8ec63f,5px 3px 0 #8ec63f,6px 3px 0 #8ec63f,7px 3px 0 #8ec63f,8px 3px 0 #8ec63f,9px 3px 0 #000,0px 4px 0 #000,1px 4px 0 #8ec63f,2px 4px 0 #8ec63f,3px 4px 0 #1a3010,4px 4px 0 #8ec63f,5px 4px 0 #8ec63f,6px 4px 0 #1a3010,7px 4px 0 #8ec63f,8px 4px 0 #8ec63f,9px 4px 0 #000,0px 5px 0 #000,1px 5px 0 #8ec63f,2px 5px 0 #8ec63f,3px 5px 0 #1a3010,4px 5px 0 #8ec63f,5px 5px 0 #8ec63f,6px 5px 0 #1a3010,7px 5px 0 #8ec63f,8px 5px 0 #8ec63f,9px 5px 0 #000,0px 6px 0 #000,1px 6px 0 #6b9930,2px 6px 0 #8ec63f,3px 6px 0 #8ec63f,4px 6px 0 #8ec63f,5px 6px 0 #8ec63f,6px 6px 0 #8ec63f,7px 6px 0 #8ec63f,8px 6px 0 #8ec63f,9px 6px 0 #000,1px 7px 0 #000,2px 7px 0 #6b9930,3px 7px 0 #8ec63f,4px 7px 0 #8ec63f,5px 7px 0 #8ec63f,6px 7px 0 #8ec63f,7px 7px 0 #8ec63f,8px 7px 0 #000,2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000;"></span>
															${hasAccessory ? html`<span style="position:absolute;left:${hasAccessory ? 3 : 4}px;top:3px;display:block;width:1px;height:1px;image-rendering:pixelated;transform:scale(2);transform-origin:0 0;box-shadow:${accShadow};${accFilter}"></span>` : ""}
														</button>
													`;
												})}
											</div>
										`)}
									</div>
								</div>
								<!-- Role picker -->
								<div>
									<div class="text-xs text-muted-foreground mb-1.5">Role</div>
									${session?.goalAssistant
										? html`<div class="text-sm text-foreground/80 px-3 py-1.5 rounded-md bg-secondary/50">Goal Assistant</div>`
										: html`
											<div class="relative">
												<button
													class="w-full text-left px-3 py-1.5 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-2"
													@click=${() => { roleDropdownOpen = !roleDropdownOpen; renderDialog(); }}
												>
													<span class="shrink-0">${statusBobbit("idle", false, sessionId, false, false, false, false, currentAccessory, true)}</span>
													<span class="flex-1 ${currentRole ? "text-foreground" : "text-muted-foreground"}">${roleLabel}</span>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground"><path d="m6 9 6 6 6-6"/></svg>
												</button>
												${roleDropdownOpen ? html`
													<div class="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg py-1 max-h-[200px] overflow-y-auto">
														<button
															class="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 ${!currentRole ? "bg-secondary/30" : ""}"
															@click=${() => doAssignRole(null)}
														>
															<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, "none", true)}</span>
															<span class="text-muted-foreground">None</span>
														</button>
														${state.roles.map((role) => html`
															<button
																class="w-full text-left px-3 py-1.5 text-sm hover:bg-secondary/50 transition-colors flex items-center gap-2 ${currentRole === role.name ? "bg-secondary/30" : ""}"
																@click=${() => doAssignRole(role.name)}
															>
																<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
																<span>${role.label}</span>
															</button>
														`)}
													</div>
												` : ""}
											</div>
										`}
								</div>
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: cleanup, children: "Cancel" })}
								${Button({ onClick: doRename, children: "Save" })}
							</div>
						`,
					})}
				`,
			}),
			container,
		);

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

// ============================================================================
// GOAL DIALOGS
// ============================================================================

export function showGoalDialog(existingGoal?: Goal): void {
	if (existingGoal) {
		showGoalEditDialog(existingGoal);
	} else {
		createGoalAssistantSession();
	}
}

async function createGoalAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ goalAssistant: true }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { isGoalAssistant: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create goal assistant", msg);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

export function showGoalEditDialogFromProposal(proposal: { title: string; spec: string; cwd?: string }): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = proposal.title;
	let cwdValue = proposal.cwd || "";
	let specValue = proposal.spec;
	let saving = false;
	let teamValue = false;
	let worktreeValue = false;
	let cwdDropdownOpen = false;
	let cwdHighlightIndex = -1;

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
		await createGoal(trimmedTitle, cwdValue.trim(), { spec: specValue, team: teamValue, worktree: worktreeValue });
		state.activeGoalProposal = null;
		if (sessionId) {
			const { terminateSession } = await import("./session-manager.js");
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
				className: "max-h-[90vh]",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						className: "overflow-y-auto",
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
									${cwdCombobox({
										value: cwdValue,
										placeholder: "(server default)",
										onInput: (v) => { cwdValue = v; renderProposalDialog(); },
										onSelect: (v) => { cwdValue = v; renderProposalDialog(); },
										dropdownOpen: cwdDropdownOpen,
										onToggle: (open) => { cwdDropdownOpen = open; renderProposalDialog(); },
										highlightedIndex: cwdHighlightIndex,
										onHighlight: (i) => { cwdHighlightIndex = i; renderProposalDialog(); },
									})}
									<div class="mt-2">
										${worktreeToggle({
											checked: worktreeValue,
											onChange: (v) => { worktreeValue = v; renderProposalDialog(); },
											id: "worktree-toggle",
										})}
									</div>
								</div>
								<div>
									<label class="text-xs text-muted-foreground mb-1 block">Goal Spec (Markdown)</label>
									<textarea
										class="w-full min-h-[160px] max-h-[300px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
										.value=${specValue}
										@input=${(e: Event) => { specValue = (e.target as HTMLTextAreaElement).value; }}
									></textarea>
								</div>
								<div class="flex items-center gap-2.5">
									<input type="checkbox" id="team-toggle"
										.checked=${teamValue}
										@change=${(e: Event) => { teamValue = (e.target as HTMLInputElement).checked; if (teamValue) worktreeValue = true; renderProposalDialog(); }}
										class="toggle-switch" />
									<label for="team-toggle" class="text-xs text-muted-foreground cursor-pointer">
										🐝 Team mode — Team Lead auto-spawns role agents
									</label>
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

function showGoalEditDialog(existingGoal: Goal): void {
	const container = document.createElement("div");
	document.body.appendChild(container);

	let titleValue = existingGoal.title;
	let cwdValue = existingGoal.cwd;
	let specValue = existingGoal.spec;
	let stateValue: GoalState = existingGoal.state;
	let saving = false;
	let teamValue = (existingGoal as any).team || false;
	let cwdDropdownOpenEdit = false;
	let cwdHighlightIndexEdit = -1;

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
			team: teamValue,
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
				className: "max-h-[90vh]",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						className: "overflow-y-auto",
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
									${cwdCombobox({
										value: cwdValue,
										placeholder: "/path/to/project",
										onInput: (v) => { cwdValue = v; renderDialog(); },
										onSelect: (v) => { cwdValue = v; renderDialog(); },
										dropdownOpen: cwdDropdownOpenEdit,
										onToggle: (open) => { cwdDropdownOpenEdit = open; renderDialog(); },
										highlightedIndex: cwdHighlightIndexEdit,
										onHighlight: (i) => { cwdHighlightIndexEdit = i; renderDialog(); },
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
								<div class="flex items-center gap-2.5">
									<input type="checkbox" id="team-toggle-edit"
										.checked=${teamValue}
										@change=${(e: Event) => { teamValue = (e.target as HTMLInputElement).checked; renderDialog(); }}
										class="toggle-switch" />
									<label for="team-toggle-edit" class="text-xs text-muted-foreground cursor-pointer">
										🐝 Team mode — Team Lead auto-spawns role agents
									</label>
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
// ASSIGN ROLE DIALOG
// ============================================================================

export async function showAssignRoleDialog(sessionId: string): Promise<void> {
	const { fetchRoles } = await import("./api.js");
	if (state.roles.length === 0) await fetchRoles();
	if (state.roles.length === 0) return; // no roles available

	const container = document.createElement("div");
	document.body.appendChild(container);

	let assigning = false;

	const cleanup = () => {
		render(html``, container);
		container.remove();
	};

	const doAssign = async (roleName: string) => {
		assigning = true;
		renderDialog();
		try {
			await gatewayFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ roleId: roleName }),
			});
			await refreshSessions();
		} catch (err) {
			console.error("[assign-role] Failed:", err);
		}
		cleanup();
		renderApp();
	};

	const renderDialog = () => {
		render(
			Dialog({
				isOpen: true,
				onClose: () => cleanup(),
				width: "min(360px, 92vw)",
				height: "auto",
				backdropClassName: "bg-black/50 backdrop-blur-sm",
				children: html`
					${DialogContent({
						children: html`
							${DialogHeader({ title: "Assign Role" })}
							<p class="text-sm text-muted-foreground mt-2 mb-3">Choose a role for this session. The agent will restart with the role's system prompt.</p>
							<div class="flex flex-col gap-1">
								${assigning
									? html`<div class="flex items-center justify-center py-4 text-sm text-muted-foreground">
										<svg class="animate-spin mr-2" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
										Assigning role…
									</div>`
									: state.roles.map(role => html`
										<button
											class="w-full text-left px-3 py-2 text-sm rounded-md hover:bg-secondary/50 text-foreground transition-colors flex items-center gap-2"
											@click=${() => doAssign(role.name)}>
											<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
											<span>${role.label}</span>
										</button>
									`)
								}
							</div>
						`,
					})}
					${DialogFooter({
						className: "px-6 pb-4",
						children: html`
							<div class="flex gap-2 justify-end">
								${Button({ variant: "ghost", onClick: () => cleanup(), children: "Cancel" })}
							</div>
						`,
					})}
				`,
			}),
			container,
		);
	};

	renderDialog();
}
