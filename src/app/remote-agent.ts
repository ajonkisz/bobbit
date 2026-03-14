import { getModel } from "@mariozechner/pi-ai";

/**
 * A remote agent adapter that connects to the Pi Gateway via WebSocket.
 * Duck-types the Agent interface from pi-agent-core so it can be used
 * with ChatPanel / AgentInterface without changes.
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export class RemoteAgent {
	private ws: WebSocket | null = null;
	private subscribers: Array<(event: any) => void> = [];
	private _state: any;
	private _gatewayUrl = "";
	private _authToken = "";
	private _sessionId = "";
	// Assistant message deferred until tool execution completes to avoid
	// showing it simultaneously in both message-list and streaming-container.
	private _deferredAssistantMessage: any = null;
	// Attachments from the most recent prompt, used to enrich the echoed
	// user message so thumbnails render in the message list.
	private _pendingAttachments: any[] | null = null;

	// Auto-reconnect state
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _reconnectAttempt = 0;
	private _intentionalDisconnect = false;
	private _connectionStatus: ConnectionStatus = "disconnected";
	private static readonly MAX_RECONNECT_DELAY = 30_000;
	private static readonly BASE_RECONNECT_DELAY = 1_000;

	// Agent interface properties (used by AgentInterface / ChatPanel)
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	streamFn: any;

	/** Callback fired when the session title changes (e.g. AI-generated summary). */
	onTitleChange?: (title: string) => void;
	onStatusChange?: (status: string) => void;
	/** Callback fired when connection status changes (connected/reconnecting/disconnected). */
	onConnectionStatusChange?: (status: ConnectionStatus) => void;
	private _title = "New session";

	constructor() {
		this._state = {
			systemPrompt: "",
			model: getModel("anthropic", "claude-opus-4-6"),
			thinkingLevel: "off",
			tools: [],
			messages: [] as any[],
			isStreaming: false,
			streamMessage: null as any,
			pendingToolCalls: new Set<string>(),
			error: undefined as string | undefined,
		};
	}

	get state() {
		return this._state;
	}
	get sessionId() {
		return this._sessionId || undefined;
	}
	get thinkingBudgets() {
		return undefined;
	}
	get transport() {
		return undefined;
	}
	get maxRetryDelayMs() {
		return undefined;
	}
	get connected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}
	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}
	get gatewaySessionId() {
		return this._sessionId;
	}
	get title() {
		return this._title;
	}

	// ── Connection ────────────────────────────────────────────────────

	async connect(gatewayUrl: string, token: string, sessionId: string): Promise<void> {
		this._gatewayUrl = gatewayUrl;
		this._authToken = token;
		this._sessionId = sessionId;
		this._intentionalDisconnect = false;
		this._reconnectAttempt = 0;

		await this._connectWs(true);
	}

	/**
	 * Internal WebSocket connect. When `initial` is true the returned promise
	 * resolves/rejects for the caller of `connect()`. On reconnect attempts
	 * (`initial` false) failures schedule the next retry silently.
	 */
	private _connectWs(initial: boolean): Promise<void> {
		const wsUrl = this._gatewayUrl.replace(/^http/, "ws");

		return new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(`${wsUrl}/ws/${this._sessionId}`);
			let settled = false;

			this.ws.onopen = () => {
				this.ws!.send(JSON.stringify({ type: "auth", token: this._authToken }));
			};

			this.ws.onmessage = (evt) => {
				let msg: any;
				try {
					msg = JSON.parse(evt.data);
				} catch {
					return;
				}

				if (!settled) {
					if (msg.type === "auth_ok") {
						settled = true;
						this._reconnectAttempt = 0;
						this._setConnectionStatus("connected");
						resolve();
						// On reconnect, request current messages to resync state
						if (!initial) {
							this.requestMessages();
							this.send({ type: "get_state" });
						}
					} else if (msg.type === "auth_failed") {
						settled = true;
						if (initial) {
							reject(new Error("Authentication failed"));
						}
						return;
					} else if (msg.type === "error") {
						settled = true;
						if (initial) {
							reject(new Error(msg.message || "Connection error"));
						}
						return;
					}
				}

				this.handleServerMessage(msg);
			};

			this.ws.onerror = () => {
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("WebSocket connection failed"));
					}
				}
			};

			this.ws.onclose = () => {
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("Connection closed before auth"));
						return;
					}
				}
				// If this wasn't an intentional disconnect, attempt to reconnect
				if (!this._intentionalDisconnect) {
					this._scheduleReconnect();
				}
			};
		});
	}

	private _setConnectionStatus(status: ConnectionStatus): void {
		if (this._connectionStatus === status) return;
		this._connectionStatus = status;
		this.onConnectionStatusChange?.(status);
	}

	private _scheduleReconnect(): void {
		if (this._intentionalDisconnect) return;

		this._setConnectionStatus("reconnecting");

		const delay = Math.min(
			RemoteAgent.BASE_RECONNECT_DELAY * Math.pow(2, this._reconnectAttempt),
			RemoteAgent.MAX_RECONNECT_DELAY,
		);
		this._reconnectAttempt++;

		this._reconnectTimer = setTimeout(async () => {
			this._reconnectTimer = null;
			if (this._intentionalDisconnect) return;
			try {
				await this._connectWs(false);
			} catch {
				// _connectWs failure on reconnect — onclose will fire and
				// schedule the next attempt automatically.
			}
		}, delay);
	}

	disconnect(): void {
		this._intentionalDisconnect = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this._setConnectionStatus("disconnected");
	}

	// ── Event subscription (Agent interface) ─────────────────────────

	subscribe(fn: (event: any) => void): () => void {
		this.subscribers.push(fn);
		return () => {
			const idx = this.subscribers.indexOf(fn);
			if (idx >= 0) this.subscribers.splice(idx, 1);
		};
	}

	private emit(event: any) {
		for (const fn of this.subscribers) {
			fn(event);
		}
	}

	// ── Agent commands (proxied to gateway) ──────────────────────────

	async prompt(input: string | any | any[], images?: any[]): Promise<void> {
		let text: string;
		let attachments: any[] | undefined;
		let imageData: any[] | undefined;

		if (typeof input === "string") {
			text = input;
		} else if (Array.isArray(input)) {
			text = input.map((m) => extractText(m)).join("\n");
		} else {
			text = extractText(input);
			// Preserve attachments from user-with-attachments messages
			if (input.role === "user-with-attachments" && input.attachments?.length) {
				attachments = input.attachments;
				// Extract image attachments as ImageContent objects for the LLM
				imageData = attachments
					?.filter((a: any) => a.type === "image" && a.content)
					.map((a: any) => ({ type: "image", data: a.content, mimeType: a.mimeType }));
			}
		}

		// Stash attachments so we can enrich the echoed user message
		this._pendingAttachments = attachments || null;

		// Don't add the user message locally — the server will echo it back
		// as message_start/message_end events, keeping a single source of truth.
		this.send({
			type: "prompt",
			text,
			...(imageData?.length ? { images: imageData } : {}),
			...(attachments?.length ? { attachments } : {}),
		});
	}

	steer(message: any): void {
		const text = typeof message === "string" ? message : extractText(message);
		this.send({ type: "steer", text });
	}

	followUp(message: any): void {
		const text = typeof message === "string" ? message : extractText(message);
		this.send({ type: "follow_up", text });
	}

	abort(): void {
		this.send({ type: "abort" });
	}

	compact(): void {
		this.send({ type: "compact" });
	}

	requestMessages(): void {
		this.send({ type: "get_messages" });
	}

	async continue(): Promise<void> {}

	async waitForIdle(): Promise<void> {
		if (!this._state.isStreaming) return;
		return new Promise<void>((resolve) => {
			const unsub = this.subscribe((ev) => {
				if (ev.type === "agent_end") {
					unsub();
					resolve();
				}
			});
		});
	}

	reset(): void {
		this._state.messages = [];
		this._state.streamMessage = null;
		this._state.isStreaming = false;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
		this._deferredAssistantMessage = null;
		this._pendingAttachments = null;
	}

	// ── Setters (Agent interface) ────────────────────────────────────

	setModel(model: any): void {
		this._state.model = model;
		this.send({ type: "set_model", model: model.id });
	}

	setThinkingLevel(level: any): void {
		this._state.thinkingLevel = level;
	}

	setTools(_tools: any[]): void {
		// no-op: tools are server-side for the coding agent
	}

	setSystemPrompt(prompt: string): void {
		this._state.systemPrompt = prompt;
	}

	replaceMessages(msgs: any[]): void {
		this._state.messages = msgs.map(enrichUserMessage);
	}

	appendMessage(msg: any): void {
		this._state.messages = [...this._state.messages, msg];
	}

	setTitle(title: string): void {
		this._title = title;
		this.send({ type: "set_title", title });
		this.onTitleChange?.(title);
	}

	generateTitle(): void {
		this.send({ type: "generate_title" });
	}

	clearSteeringQueue(): void {}
	clearFollowUpQueue(): void {}
	clearAllQueues(): void {}
	hasQueuedMessages(): boolean {
		return false;
	}

	// ── Internal ─────────────────────────────────────────────────────

	private send(msg: any): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private handleServerMessage(msg: any) {
		switch (msg.type) {
			case "state":
				if (msg.data?.isStreaming !== undefined) {
					this._state.isStreaming = msg.data.isStreaming;
				}
				break;

			case "messages": {
				const msgs = Array.isArray(msg.data) ? msg.data : msg.data?.messages;
				if (Array.isArray(msgs)) {
					this._state.messages = msgs.map(enrichUserMessage);
					// Emit message_end for each message so AgentInterface re-renders
					for (const m of this._state.messages) {
						this.emit({ type: "message_end", message: m });
					}
				}
				break;
			}

			case "event":
				this.handleAgentEvent(msg.data);
				break;

			case "session_status":
				this._state.isStreaming = msg.status === "streaming";
				this.onStatusChange?.(msg.status);
				break;

			case "session_title":
				this._title = msg.title;
				this.onTitleChange?.(msg.title);
				break;

			case "error":
				console.error(`[RemoteAgent] Server error: ${msg.message} (${msg.code})`);
				// If we were streaming, stop. If there's a pending prompt that
				// failed, the user message was already cleared from the editor
				// but never echoed back — surface the error so the user knows.
				this._state.isStreaming = false;
				this._state.error = msg.message || "Unknown server error";
				this._pendingAttachments = null;
				// Add a dismissable error message to the chat history
				this._state.messages = [...this._state.messages, {
					role: "error",
					content: msg.message || "Unknown server error",
					code: msg.code,
					timestamp: Date.now(),
					id: `err_${Date.now()}_${Math.random().toString(36).slice(2)}`,
				} as any];
				this.emit({ type: "error", error: msg.message });
				break;
		}
	}

	/**
	 * Move any deferred assistant message into the stable messages array
	 * and clear streamMessage. Called at points where the streaming container
	 * is simultaneously updated (message_update replaces its content,
	 * message_end of non-assistant clears it, agent_end clears it) so the
	 * tool call never appears in both message-list and streaming-container.
	 */
	private flushDeferredMessage() {
		if (this._deferredAssistantMessage) {
			this._state.messages = [...this._state.messages, this._deferredAssistantMessage];
			this._state.streamMessage = null;
			this._deferredAssistantMessage = null;
		}
	}

	private handleAgentEvent(event: any) {
		// Update local state BEFORE emitting (UI reads state in event handlers)
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				break;

			case "agent_end":
				this.flushDeferredMessage();
				this._state.isStreaming = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();
				break;

			case "message_start":
				// Don't add messages here — wait for message_end which
				// carries the finalized message and allows proper ordering
				// with any deferred assistant message.
				break;

			case "message_update":
				// Flush any deferred assistant message now that a new message
				// is being streamed — the streaming container will switch to
				// the new message via setMessage(), so the old one only lives
				// in message-list from now on.
				this.flushDeferredMessage();
				if (event.message) {
					this._state.streamMessage = event.message;
				}
				break;

			case "message_end":
				if (event.message) {
					if (event.message.role === "assistant") {
						// Check whether this assistant message contains tool calls.
						const hasToolCalls = Array.isArray(event.message.content) &&
							event.message.content.some((c: any) => c.type === "toolCall");

						if (hasToolCalls) {
							// Defer adding the message to messages[]. The streaming
							// container still holds this message from the last
							// message_update, so it will keep rendering the tool
							// call. By NOT adding to messages[] we avoid a duplicate
							// in message-list. The deferred message will be flushed
							// when the next message_update arrives (which replaces
							// the streaming container content simultaneously).
							this._deferredAssistantMessage = event.message;
							// Keep streamMessage set so the AgentInterface
							// message_end handler does NOT clear the streaming
							// container.
						} else {
							// No tool calls — safe to add immediately.
							this._state.streamMessage = null;
							this._state.messages = [...this._state.messages, event.message];
						}
					} else {
						// Non-assistant messages (user, toolResult).
						// Flush any deferred assistant message first so it
						// appears before this message in the correct order.
						this.flushDeferredMessage();
						this._state.streamMessage = null;

						let msg = event.message;
						// Enrich echoed user messages with stashed attachments
						// so image thumbnails render in the message list.
						if (msg.role === "user" && this._pendingAttachments) {
							msg = {
								...msg,
								role: "user-with-attachments",
								attachments: this._pendingAttachments,
							};
							this._pendingAttachments = null;
						}

						this._state.messages = [...this._state.messages, msg];
					}
				}
				break;

			case "tool_execution_start":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.add(event.toolCallId);
				}
				break;

			case "tool_execution_end":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.delete(event.toolCallId);
				}
				break;

			case "compaction_start":
				this._state.isStreaming = true;
				// Add a status message to chat
				this._state.messages = [...this._state.messages, {
					role: "assistant",
					content: [{ type: "text", text: "Compacting context..." }],
					timestamp: Date.now(),
					id: `compact_${Date.now()}`,
					_isCompacting: true,
				} as any];
				break;

			case "compaction_end": {
				this._state.isStreaming = false;
				// Remove the "compacting" placeholder
				this._state.messages = this._state.messages.filter((m: any) => !m._isCompacting);
				if (event.success) {
					// Add a success message
					this._state.messages = [...this._state.messages, {
						role: "assistant",
						content: [{ type: "text", text: "Context compacted successfully." }],
						timestamp: Date.now(),
						id: `compact_done_${Date.now()}`,
					} as any];
				} else {
					this._state.messages = [...this._state.messages, {
						role: "assistant",
						content: [{ type: "text", text: `Compaction failed: ${event.error || "Unknown error"}` }],
						timestamp: Date.now(),
						id: `compact_err_${Date.now()}`,
					} as any];
				}
				// State and messages refresh will arrive from the server
				break;
			}
		}

		// Forward event to UI subscribers
		this.emit(event);
	}
}

/**
 * When restoring messages from the server (page refresh, reconnect),
 * user messages with image content arrive as `{ role: "user", content: [...] }`
 * but the UI needs `role: "user-with-attachments"` with an `attachments` array
 * to render image thumbnails. This function reconstructs that format.
 */
function enrichUserMessage(msg: any): any {
	if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

	const imageChunks = msg.content.filter((c: any) => c.type === "image" && c.data);
	if (imageChunks.length === 0) return msg;

	const attachments = imageChunks.map((img: any, i: number) => ({
		id: `restored_${i}_${Date.now()}`,
		type: "image" as const,
		fileName: `image-${i + 1}.png`,
		mimeType: img.mimeType || img.media_type || "image/png",
		size: img.data?.length || 0,
		content: img.data,
		preview: img.data,
	}));

	return {
		...msg,
		role: "user-with-attachments",
		attachments,
	};
}

function extractText(message: any): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join("\n");
	}
	return "";
}
