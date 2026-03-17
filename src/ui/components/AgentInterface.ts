import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { streamSimple, type ToolResultMessage, type Usage } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { Brain, Sparkles } from "lucide";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import type { MessageEditor, QueuedMessage } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Attachment } from "../utils/attachment-utils.js";
import { formatCost, formatTokenCount } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Working directory shown in the stats bar
	@property() cwd?: string;
	// Git branch name shown in the stats bar
	@property() branch?: string;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _stickToBottom = true;
	private _isAutoScrolling = false;
	private _autoScrollTimer?: ReturnType<typeof setTimeout>;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;
	private _queuedMessages: QueuedMessage[] = [];
	private _queueIdCounter = 0;

	private _queueStorageKey(): string | undefined {
		const id = this.session?.sessionId;
		return id ? `bobbit_queue_${id}` : undefined;
	}

	private _saveQueuedMessages() {
		const key = this._queueStorageKey();
		if (!key) return;
		try {
			// Persist text-only (skip attachments — they may contain large base64 data)
			const serializable = this._queuedMessages.map(({ id, text, steered }) => ({ id, text, steered }));
			if (serializable.length > 0) {
				sessionStorage.setItem(key, JSON.stringify(serializable));
			} else {
				sessionStorage.removeItem(key);
			}
		} catch { /* quota exceeded — ignore */ }
	}

	private _restoreQueuedMessages() {
		const key = this._queueStorageKey();
		if (!key) return;
		try {
			const raw = sessionStorage.getItem(key);
			if (raw) {
				const restored: QueuedMessage[] = JSON.parse(raw);
				if (Array.isArray(restored) && restored.length > 0) {
					this._queuedMessages = restored;
					this._queueIdCounter = Math.max(this._queueIdCounter, ...restored.map(m => {
						const n = parseInt(m.id.replace("q_", ""), 10);
						return isNaN(n) ? 0 : n;
					}));
					this.requestUpdate();
				}
			}
		} catch { /* parse error — ignore */ }
	}

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._stickToBottom = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// When content changes size, scroll to bottom if we're already there.
			// Uses _stickToBottom flag — no keyboard/focus/viewport tracking needed.
			// We set _isAutoScrolling to prevent the scroll event handler from
			// misinterpreting the programmatic scroll as a user scroll-up (which
			// can happen when content grows between the programmatic scroll and
			// the resulting scroll event).
			this._resizeObserver = new ResizeObserver(() => {
				if (this._stickToBottom && this._scrollContainer) {
					this._isAutoScrolling = true;
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
					// Clear the flag on a timeout rather than rAF — in Chrome,
					// scroll events fire *after* rAF callbacks (during "run the
					// scroll steps"), so an rAF-based reset races with the
					// scroll handler and can falsely set _stickToBottom = false.
					clearTimeout(this._autoScrollTimer);
					this._autoScrollTimer = setTimeout(() => {
						this._isAutoScrolling = false;
					}, 150);
				}
			});

			const contentContainer = this._scrollContainer.querySelector(".max-w-5xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Track user scroll to decide stick-to-bottom state
			this._scrollContainer.addEventListener("scroll", this._handleScroll, { passive: true });
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up timers, observers, and listeners
		clearTimeout(this._autoScrollTimer);
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;

		// Reset scroll state for new session and scroll to bottom once rendered
		this._stickToBottom = true;
		this.updateComplete.then(() => this._scrollToBottom());

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const enabled = await getAppStorage().settings.get<boolean>("proxy.enabled");
				return enabled ? (await getAppStorage().settings.get<string>("proxy.url")) || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		// Restore any queued messages from a previous page load
		this._restoreQueuedMessages();

		// If the session is already compacting (e.g. page refresh mid-compaction),
		// start the animation once the DOM is ready — we missed the compaction_start event.
		if ((this.session as any)._isCompacting) {
			this.updateComplete.then(() => {
				if (this._streamingContainer) this._streamingContainer.startCompacting();
				this.requestUpdate();
			});
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			// Handle custom events not in AgentEvent union
			if ((ev as any).type === "compaction_start") {
				if (this._streamingContainer) this._streamingContainer.startCompacting();
				this.requestUpdate();
				return;
			}
			if ((ev as any).type === "compaction_end") {
				if (this._streamingContainer) this._streamingContainer.endCompacting();
				this.requestUpdate();
				return;
			}
			if ((ev as any).type === "state_update") {
				// Server state refresh (e.g. after compaction or reconnect) — re-render stats
				// and scroll to bottom if we were tracking bottom (content may have been
				// bulk-replaced without triggering a ResizeObserver change).
				this.requestUpdate();
				if (this._stickToBottom) {
					this.updateComplete.then(() => this._scrollToBottom());
				}
				return;
			}
			if ((ev as any).type === "tool_execution_update") {
				// Partial results from long-running tools (delegate, workflow run_phase)
				// Force streaming container to re-render with updated delegate cards
				this.requestUpdate();
				if (this._streamingContainer) {
					this._streamingContainer.toolPartialResults = (this.session?.state as any)?.toolPartialResults;
					this._streamingContainer.requestUpdate();
				}
				return;
			}
			switch (ev.type) {
				case "message_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "turn_start":
					// Clear steered messages — the agent has picked them up
					if (this._queuedMessages.some((m) => m.steered)) {
						this._queuedMessages = this._queuedMessages.filter((m) => !m.steered);
						this._saveQueuedMessages();
					}
					this.requestUpdate();
					break;
				case "message_end":
					// When a message finishes, sync the streaming container
					// with the current streamMessage state.  If the agent
					// cleared streamMessage (e.g. message without tool calls),
					// we clear the container so the finalized message only
					// appears in message-list.  If streamMessage is still set
					// (deferred tool-call message), the container keeps it.
					if (this._streamingContainer) {
						const sm = this.session?.state.streamMessage;
						if (!sm) {
							this._streamingContainer.setMessage(null, true);
						}
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					// Drain queued messages — send the first as a prompt, rest as follow-ups
					this.drainQueue();
					this.requestUpdate();
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _scrollToBottom() {
		this._stickToBottom = true;
		this._isAutoScrolling = true;
		if (this._scrollContainer) {
			this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
		}
		// Re-assert after next frame (layout may not have settled yet)
		requestAnimationFrame(() => {
			if (this._scrollContainer) {
				this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
			}
		});
		// Clear auto-scroll guard on a timeout that outlasts the browser's
		// scroll event dispatch (see ResizeObserver comment for rationale).
		clearTimeout(this._autoScrollTimer);
		this._autoScrollTimer = setTimeout(() => {
			this._isAutoScrolling = false;
		}, 150);
	}

	/**
	 * Simple stick-to-bottom: if the user is near the bottom, stay there.
	 * If they've scrolled up, don't pull them back down.
	 * No keyboard/focus/viewport tracking — just geometry.
	 */
	private _handleScroll = () => {
		if (!this._scrollContainer || this._isAutoScrolling) return;
		const { scrollTop, scrollHeight, clientHeight } = this._scrollContainer;
		this._stickToBottom = scrollHeight - scrollTop - clientHeight < 50;
	};

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if (!input.trim() && (!attachments || attachments.length === 0)) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");

		// Handle /compact slash command
		if (input.trim().toLowerCase() === "/compact") {
			if ("compact" in session && typeof (session as any).compact === "function") {
				this._messageEditor.value = "";
				this._messageEditor.attachments = [];
				// Show the command as a user message in chat
				const userMsg = {
					role: "user" as const,
					content: "/compact",
					timestamp: Date.now(),
					id: `compact_cmd_${Date.now()}`,
				};
				session.state.messages = [...session.state.messages, userMsg];
				// Store as synthetic so it survives the server's messages refresh
				if ((session as any)._compactionSyntheticMessages) {
					(session as any)._compactionSyntheticMessages = [userMsg];
				}
				this.requestUpdate();

				// Drive the blob compaction animation from the client side.
				// We start the squash animation immediately, then listen for
				// the server's compaction_end event (or messages refresh) to
				// pop back and show the result.
				if (this._streamingContainer) {
					this._streamingContainer.startCompacting();
				}
				(session as any).compact();
			}
			return;
		}
		if (!session.state.model) throw new Error("No model set on AgentInterface");

		const isStreaming = session.state.isStreaming;

		// Check if API key exists for the provider (only needed in direct mode, skip for queued messages)
		if (!isStreaming) {
			const provider = session.state.model.provider;
			const apiKey = await getAppStorage().providerKeys.get(provider);

			// If no API key, prompt for it
			if (!apiKey) {
				if (!this.onApiKeyRequired) {
					console.error("No API key configured and no onApiKeyRequired handler set");
					return;
				}

				const success = await this.onApiKeyRequired(provider);

				// If still no API key, abort the send
				if (!success) {
					return;
				}
			}
		}

		// Call onBeforeSend hook before sending
		if (this.onBeforeSend) {
			await this.onBeforeSend();
		}

		// Only clear editor after we know we can send
		this._messageEditor.value = "";
		this._messageEditor.attachments = [];
		// Snap to bottom when sending a message.
		// Set flag and scroll immediately, then re-assert after render
		// (scroll events from layout changes can race and unset the flag).
		this._stickToBottom = true;
		this._scrollToBottom();

		if (isStreaming) {
			// Agent is busy — add to local queue, will be sent on agent_end
			this._queuedMessages = [...this._queuedMessages, {
				id: `q_${++this._queueIdCounter}`,
				text: input,
				attachments: attachments?.length ? attachments : undefined,
			}];
			this._saveQueuedMessages();
			this.requestUpdate();
		} else {
			// Agent is idle — send as regular prompt
			if (attachments && attachments.length > 0) {
				const message: UserMessageWithAttachments = {
					role: "user-with-attachments",
					content: input,
					attachments,
					timestamp: Date.now(),
				};
				await session.prompt(message);
			} else {
				await session.prompt(input);
			}
		}
	}

	/** Send queued messages to the agent now that it's idle */
	private async drainQueue() {
		if (this._queuedMessages.length === 0 || !this.session) return;
		// Filter out steered messages — they were already sent
		const queue = this._queuedMessages.filter((m) => !m.steered);
		this._queuedMessages = [];
		this._saveQueuedMessages();
		this.requestUpdate();

		if (queue.length === 0) return;

		// Send the first message as a prompt (starts a new turn)
		const first = queue[0];
		if (first.attachments?.length) {
			const msg: UserMessageWithAttachments = {
				role: "user-with-attachments",
				content: first.text,
				attachments: first.attachments,
				timestamp: Date.now(),
			};
			await this.session.prompt(msg);
		} else {
			await this.session.prompt(first.text);
		}

		// Queue the rest as follow-ups
		for (let i = 1; i < queue.length; i++) {
			const q = queue[i];
			if (q.attachments?.length) {
				this.session.followUp({
					role: "user-with-attachments",
					content: q.text,
					attachments: q.attachments,
					timestamp: Date.now(),
				} as any);
			} else {
				this.session.followUp({ role: "user", content: q.text, timestamp: Date.now() });
			}
		}
	}

	/** Promote a queued message to a steer — interrupts the current turn */
	private steerMessage(msg: QueuedMessage) {
		if (!this.session) return;
		// Mark as steered — stays visible with "Sent" indicator until agent_end
		this._queuedMessages = this._queuedMessages.map((m) =>
			m.id === msg.id ? { ...m, steered: true } : m,
		);
		this._saveQueuedMessages();
		this.requestUpdate();

		if (msg.attachments?.length) {
			this.session.steer({
				role: "user-with-attachments",
				content: msg.text,
				attachments: msg.attachments,
				timestamp: Date.now(),
			} as any);
		} else {
			this.session.steer({ role: "user", content: msg.text, timestamp: Date.now() });
		}
	}

	/** Remove a message from the queue without sending */
	private removeQueuedMessage(id: string) {
		this._queuedMessages = this._queuedMessages.filter((m) => m.id !== id);
		this._saveQueuedMessages();
		this.requestUpdate();
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this.session.state.messages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.hasStreamMessage=${!!state.streamMessage}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
					.onDismissError=${(id: string) => {
						if (!this.session) return;
						this.session.state.messages = this.session.state.messages.filter(
							(m: any) => !(m.role === "error" && m.id === id)
						);
						this.requestUpdate();
					}}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.toolPartialResults=${(state as any).toolPartialResults}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>

			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const costText = totals.cost?.total ? formatCost(totals.cost.total) : "";

		// Compute context usage from the last assistant message's usage
		let contextHtml = html``;
		const model = state.model;
		// After compaction, the last assistant message's usage reflects the old
		// (pre-compaction) context size.  Show "?" until the next real LLM
		// response provides fresh usage data (matches the TUI behaviour).
		const usageStale = (this.session as any)?._usageStaleAfterCompaction === true;
		if (model?.contextWindow) {
			if (usageStale) {
				// Show an empty bar with "?" — exact token count unknown until next response
				contextHtml = html`
					<span class="flex items-center gap-1.5" title="Context usage unknown until next response">
						<span style="display:inline-flex;align-items:center;width:48px;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden">
							<span style="width:0%;height:100%;background:var(--primary,#3b82f6);border-radius:3px;transition:width 0.3s"></span>
						</span>
						<span>—</span>
					</span>
				`;
			} else {
				// Find last assistant message with usage (skip aborted/error)
				let lastUsage: Usage | undefined;
				for (let i = state.messages.length - 1; i >= 0; i--) {
					const msg = state.messages[i] as any;
					if (msg.role === "assistant" && msg.usage && msg.stopReason !== "aborted" && msg.stopReason !== "error") {
						lastUsage = msg.usage;
						break;
					}
				}

				if (lastUsage) {
					const contextTokens = lastUsage.totalTokens || (lastUsage.input + lastUsage.output + lastUsage.cacheRead + lastUsage.cacheWrite);
					const contextWindow = model.contextWindow;
					const pct = Math.min(100, Math.round((contextTokens / contextWindow) * 100));
					const barColor = pct >= 90 ? "var(--destructive, #ef4444)" : pct >= 75 ? "var(--warning, #f59e0b)" : "var(--primary, #3b82f6)";
					contextHtml = html`
						<span class="flex items-center gap-1.5" title="Context: ${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} tokens (${pct}%)">
							<span style="display:inline-flex;align-items:center;width:48px;height:6px;background:var(--muted,#27272a);border-radius:3px;overflow:hidden">
								<span style="width:${pct}%;height:100%;background:${barColor};border-radius:3px;transition:width 0.3s"></span>
							</span>
							<span>${pct}%</span>
						</span>
					`;
				}
			}
		}

		const session = this.session!;
		const supportsThinking = (state.model as any)?.reasoning === true;

		const thinkingSelect = supportsThinking && this.enableThinkingSelector
			? Select({
				value: state.thinkingLevel,
				placeholder: i18n("Off"),
				options: [
					{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
					{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
					{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
					{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
					{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
				] as SelectOption[],
				onChange: (value: string) => {
					session.setThinkingLevel(value as any);
				},
				width: "80px",
				size: "sm",
				variant: "ghost",
				fitContent: true,
			})
			: "";

		const modelButton = this.enableModelSelector && state.model
			? Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					ModelSelector.open(state.model, (m) => session.setModel(m));
				},
				children: html`
					${icon(Sparkles, "sm")}
					<span class="ml-1.5">${state.model.id}</span>
				`,
				className: "h-6 text-xs truncate",
			})
			: "";

		const cwdHtml = this.cwd ? (() => {
			const parts = this.cwd!.split(/[/\\]/).filter(Boolean);
			const short = parts.length <= 2 ? parts.join("/") : "…/" + parts.slice(-2).join("/");
			const branchBadge = this.branch
				? html`<span class="opacity-50">·</span><span class="opacity-60 truncate" style="max-width:120px;" title="${this.branch}">⎇ ${this.branch.replace(/^goal\//, "")}</span>`
				: "";
			return html`<span class="font-mono opacity-60 flex items-center gap-1 truncate" style="max-width:280px;" title="${this.cwd}">${short}${branchBadge}</span>`;
		})() : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center mt-0.5">
				<div class="flex items-center">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
					${thinkingSelect}
					${modelButton}
				</div>
				${cwdHtml ? html`<div class="flex items-center pl-4">${cwdHtml}</div>` : ""}
				<div class="flex ml-auto items-center gap-3">
					${contextHtml}
					${
						costText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${costText}</span>`
								: html`<span>${costText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-5xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0 pt-0 pb-1">
					<div class="max-w-5xl mx-auto px-2">
						<message-editor
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.queuedMessages=${this._queuedMessages}
							.onSend=${(input: string, attachments: Attachment[]) => {
								this.sendMessage(input, attachments);
							}}
							.onAbort=${() => session.abort()}
							.onSteer=${(msg: QueuedMessage) => this.steerMessage(msg)}
							.onRemoveQueued=${(id: string) => this.removeQueuedMessage(id)}
							.onModelSelect=${() => {
								ModelSelector.open(state.model, (model) => session.setModel(model));
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.setThinkingLevel(level);
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
