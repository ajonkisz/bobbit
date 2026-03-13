import { getModel } from "@mariozechner/pi-ai";

/**
 * A remote agent adapter that connects to the Pi Gateway via WebSocket.
 * Duck-types the Agent interface from pi-agent-core so it can be used
 * with ChatPanel / AgentInterface without changes.
 */
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

	// Agent interface properties (used by AgentInterface / ChatPanel)
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	streamFn: any;

	constructor() {
		this._state = {
			systemPrompt: "",
			model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
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
	get gatewaySessionId() {
		return this._sessionId;
	}

	// ── Connection ────────────────────────────────────────────────────

	async connect(gatewayUrl: string, token: string, sessionId: string): Promise<void> {
		this._gatewayUrl = gatewayUrl;
		this._authToken = token;
		this._sessionId = sessionId;

		const wsUrl = gatewayUrl.replace(/^http/, "ws");

		return new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(`${wsUrl}/ws/${sessionId}`);
			let settled = false;

			this.ws.onopen = () => {
				this.ws!.send(JSON.stringify({ type: "auth", token }));
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
						resolve();
					} else if (msg.type === "auth_failed") {
						settled = true;
						reject(new Error("Authentication failed"));
						return;
					} else if (msg.type === "error") {
						settled = true;
						reject(new Error(msg.message || "Connection error"));
						return;
					}
				}

				this.handleServerMessage(msg);
			};

			this.ws.onerror = () => {
				if (!settled) {
					settled = true;
					reject(new Error("WebSocket connection failed"));
				}
			};

			this.ws.onclose = () => {
				if (!settled) {
					settled = true;
					reject(new Error("Connection closed before auth"));
				}
			};
		});
	}

	disconnect(): void {
		this.ws?.close();
		this.ws = null;
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
		if (typeof input === "string") {
			text = input;
		} else if (Array.isArray(input)) {
			text = input.map((m) => extractText(m)).join("\n");
		} else {
			text = extractText(input);
		}

		// Don't add the user message locally — the server will echo it back
		// as message_start/message_end events, keeping a single source of truth.
		this.send({ type: "prompt", text });
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
		this._state.messages = msgs;
	}

	appendMessage(msg: any): void {
		this._state.messages = [...this._state.messages, msg];
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
					this._state.messages = msgs;
					// Emit message_end for each message so AgentInterface re-renders
					for (const m of msgs) {
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
						this._state.messages = [...this._state.messages, event.message];
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
		}

		// Forward event to UI subscribers
		this.emit(event);
	}
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
