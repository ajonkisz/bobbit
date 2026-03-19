import { getModel } from "@mariozechner/pi-ai";

/**
 * A remote agent adapter that connects to the Pi Gateway via WebSocket.
 * Duck-types the Agent interface from pi-agent-core so it can be used
 * with ChatPanel / AgentInterface without changes.
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** A message waiting in the server-side prompt queue (mirrors server QueuedMessage) */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	/** True if already dispatched mid-turn via steer RPC (kept in queue for UI) */
	dispatched?: boolean;
	createdAt: number;
}

export class RemoteAgent {
	private ws: WebSocket | null = null;
	private subscribers: Array<(event: any) => void> = [];
	private _state: any;
	private _gatewayUrl = "";
	private _authToken = "";
	private _sessionId = "";
	// Server-authoritative prompt queue
	private _serverQueue: QueuedMessage[] = [];
	// Assistant message deferred until tool execution completes to avoid
	// showing it simultaneously in both message-list and streaming-container.
	private _deferredAssistantMessage: any = null;
	// Attachments from the most recent prompt, used to enrich the echoed
	// user message so thumbnails render in the message list.
	private _pendingAttachments: any[] | null = null;

	// Compaction tracking — persists across message refreshes.
	// Exposed on state so the UI can queue messages during compact.
	private _isCompacting = false;
	private _isAborting = false;

	// After compaction, usage from the last assistant message is stale (reflects
	// pre-compaction context size).  Set to true on compaction_end, cleared when
	// a new assistant message with usage arrives.  The UI checks this to avoid
	// showing a misleading context percentage.
	private _usageStaleAfterCompaction = false;

	// Synthetic messages added around compaction (/compact user msg + result).
	// Kept separately so they survive the server's post-compaction messages refresh.
	private _compactionSyntheticMessages: any[] = [];

	// Task timing — track when the agent started working so we can
	// notify the user if a long task finishes while the tab is hidden.
	private _taskStartTime: number | null = null;
	private static readonly LONG_TASK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

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
	/** Callback fired when a goal proposal is detected in an assistant message. */
	onGoalProposal?: (proposal: { title: string; spec: string; cwd?: string }) => void;
	/** Callback fired when a role proposal is detected in an assistant message. */
	onRoleProposal?: (proposal: { name: string; label: string; prompt: string; tools: string; accessory: string }) => void;
	/** Callback fired when tool execution updates (for real-time progress). */
	onWorkflowUpdate?: () => void;
	/** Callback fired when the server-side prompt queue changes. */
	onQueueUpdate?: (queue: QueuedMessage[]) => void;
	private _title = "New session";

	constructor() {
		this._state = {
			systemPrompt: "",
			model: getModel("anthropic", "claude-opus-4-6"),
			thinkingLevel: "off",
			tools: [],
			messages: [] as any[],
			isStreaming: false,
			isCompacting: false,
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

	private static readonly CONNECT_TIMEOUT_MS = 15_000;

	async connect(gatewayUrl: string, token: string, sessionId: string): Promise<void> {
		this._gatewayUrl = gatewayUrl;
		this._authToken = token;
		this._sessionId = sessionId;
		this._intentionalDisconnect = false;
		this._reconnectAttempt = 0;

		// Best-effort permission request (may be ignored without a user gesture).
		RemoteAgent._requestNotificationPermission();

		// Race the WebSocket connect against a timeout so we don't hang
		// forever on degraded mobile networks.
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Connection timed out")), RemoteAgent.CONNECT_TIMEOUT_MS);
		});

		try {
			await Promise.race([this._connectWs(true), timeout]);
		} catch (err) {
			// If timed out, clean up the pending WebSocket
			this._intentionalDisconnect = true;
			this.ws?.close();
			this.ws = null;
			throw err;
		}
	}

	private static _notificationPermissionRequested = false;

	/** Request browser notification permission (once per page load, requires user gesture). */
	private static _requestNotificationPermission(): void {
		if (RemoteAgent._notificationPermissionRequested) return;
		if (typeof Notification === "undefined" || Notification.permission !== "default") return;
		Notification.requestPermission().then(() => {
			if (Notification.permission !== "default") {
				RemoteAgent._notificationPermissionRequested = true;
			}
		}).catch(() => {});
	}

	// Title-flash state for long-task notifications
	private _titleFlashTimer: ReturnType<typeof setInterval> | null = null;
	private _originalTitle: string | null = null;

	/**
	 * Notify the user that a long-running task finished while the tab is
	 * hidden. Uses two mechanisms that work over plain HTTP:
	 *   1. Flashing the document title (stops when the tab regains focus)
	 *   2. A short notification beep via the Web Audio API
	 * Falls back to the Notification API when available (secure contexts).
	 */
	private _notifyTaskComplete(elapsedMs: number): void {
		// TODO: restore visibility check after testing
		// if (document.visibilityState === "visible") return;

		const mins = Math.round(elapsedMs / 60_000);

		// ── Notification API (works on HTTPS / localhost) ────────────
		if (typeof Notification !== "undefined" && Notification.permission === "granted") {
			const title = this._title || "Bobbit";
			const body = `Task completed after ${mins} minute${mins === 1 ? "" : "s"}. Awaiting your input.`;
			const n = new Notification(title, { body, tag: `bobbit-done-${this._sessionId}` });
			n.onclick = () => { window.focus(); n.close(); };
		}

		// ── Title flash (works everywhere) ───────────────────────────
		this._startTitleFlash(`✅ Done (${mins}m) — ${this._title || "Bobbit"}`);

		// ── Audio beep via Web Audio API ─────────────────────────────
		RemoteAgent._playNotificationBeep();
	}

	private _startTitleFlash(alertText: string): void {
		// Don't stack multiple flashes
		if (this._titleFlashTimer) return;
		this._originalTitle = document.title;
		let showAlert = true;
		this._titleFlashTimer = setInterval(() => {
			document.title = showAlert ? alertText : (this._originalTitle || "Bobbit");
			showAlert = !showAlert;
		}, 1000);

		// Stop flashing when the user returns to the tab
		const stop = () => {
			if (this._titleFlashTimer) {
				clearInterval(this._titleFlashTimer);
				this._titleFlashTimer = null;
			}
			if (this._originalTitle !== null) {
				document.title = this._originalTitle;
				this._originalTitle = null;
			}
			document.removeEventListener("visibilitychange", onVisible);
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") stop();
		};
		document.addEventListener("visibilitychange", onVisible);
	}

	/** Play a short two-tone beep using the Web Audio API (no file needed). */
	private static _playNotificationBeep(): void {
		try {
			const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
			const now = ctx.currentTime;

			// Two short tones: 880 Hz then 1046 Hz
			for (const [freq, start] of [[880, 0], [1046, 0.15]] as const) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0.15, now + start);
				gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.12);
				osc.connect(gain).connect(ctx.destination);
				osc.start(now + start);
				osc.stop(now + start + 0.12);
			}

			// Close the context after the beep finishes
			setTimeout(() => ctx.close().catch(() => {}), 500);
		} catch {
			// Web Audio not available — silently skip
		}
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

		// Request notification permission on first prompt (has user gesture).
		RemoteAgent._requestNotificationPermission();

		// Stash attachments so we can enrich the echoed user message
		this._pendingAttachments = attachments || null;

		// Clear compaction synthetic messages — they were only needed to survive
		// the post-compaction refresh; a new prompt starts a fresh turn.
		this._compactionSyntheticMessages = [];
		this._usageStaleAfterCompaction = false;

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

	get isAborting(): boolean { return this._isAborting; }

	abort(): void {
		this._isAborting = true;
		this.send({ type: "abort" });
	}

	/** Retry after a model/API error. */
	retry(): void {
		this.send({ type: "retry" });
	}

	compact(): void {
		this.send({ type: "compact" });
	}

	/** Add or re-add the "Compacting context…" placeholder to the message list. */
	private _addCompactingPlaceholder(): void {
		this._state.messages = [...this._state.messages.filter((m: any) => m.id !== "compacting_placeholder"), {
			role: "assistant",
			content: [{ type: "text", text: "Compacting context…" }],
			timestamp: Date.now(),
			id: "compacting_placeholder",
		} as any];
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
		this.send({ type: "set_model", provider: model.provider, modelId: model.id });
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
		return this._serverQueue.length > 0;
	}

	/** Get the current server-authoritative prompt queue. */
	getQueue(): QueuedMessage[] {
		return this._serverQueue;
	}

	/** Ask the server to promote a queued message to a steer. */
	steerQueued(messageId: string): void {
		this.send({ type: "steer_queued", messageId });
	}

	/** Ask the server to remove a message from the queue. */
	removeQueued(messageId: string): void {
		this.send({ type: "remove_queued", messageId });
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
				// Always update model from server state (keeps context window accurate after compaction)
				if (msg.data?.model) {
					this._state.model = msg.data.model;
				}
				this.emit({ type: "state_update", data: msg.data });
				break;

			case "messages": {
				const msgs = Array.isArray(msg.data) ? msg.data : msg.data?.messages;
				if (Array.isArray(msgs)) {
					this._state.messages = msgs.map(enrichUserMessage);
					// Re-append synthetic compaction messages (/compact + result)
					// so they survive the server's post-compaction refresh.
					if (this._compactionSyntheticMessages.length > 0) {
						this._state.messages = [...this._state.messages, ...this._compactionSyntheticMessages];
					}
					// Emit message_end for each message so AgentInterface re-renders
					for (const m of this._state.messages) {
						this.emit({ type: "message_end", message: m });
					}
					// Scan loaded messages for goal proposals (e.g. reconnecting to an existing session)
					for (const m of this._state.messages) {
						if (m.role === "assistant") {
							this._checkForGoalProposal(m);
							this._checkForRoleProposal(m);
						}
					}
					// Re-add compacting placeholder if compaction is still in progress
					if (this._isCompacting) {
						this._addCompactingPlaceholder();
					}
					// Note: we intentionally do NOT try to reconstruct streamMessage
					// for late-joining clients. The message-list will show all messages
					// including pending tool calls. The streaming container will pick up
					// new events as they arrive.
				}
				break;
			}

			case "event":
				if (msg.data?.type === "agent_start" || msg.data?.type === "agent_end") {
					console.log(`[RemoteAgent] event: ${msg.data.type}, isStreaming: ${this._state.isStreaming}`);
				}
				this.handleAgentEvent(msg.data);
				break;

			case "session_status":
				console.log(`[RemoteAgent] session_status: ${msg.status}, isStreaming was: ${this._state.isStreaming}`);
				this._state.isStreaming = msg.status === "streaming";
				if (msg.status !== "streaming") this._isAborting = false;
				this.onStatusChange?.(msg.status);
				break;

			case "session_title":
				this._title = msg.title;
				this.onTitleChange?.(msg.title);
				break;

			case "queue_update":
				this._serverQueue = Array.isArray(msg.queue) ? msg.queue : [];
				this.onQueueUpdate?.(this._serverQueue);
				break;

			case "open_preview":
				import("./preview-panel.js").then(m => m.startPreviewPolling());
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
	/** Check an assistant message for a <goal_proposal> block and fire the callback. */
	private _checkForGoalProposal(message: any): void {
		if (!this.onGoalProposal) return;

		// Extract text content from the message
		let text = "";
		if (typeof message.content === "string") {
			text = message.content;
		} else if (Array.isArray(message.content)) {
			text = message.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join("");
		}
		if (!text) return;

		const match = text.match(/<goal_proposal>([\s\S]*?)<\/goal_proposal>/);
		if (!match) return;

		const block = match[1];
		const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
		const specMatch = block.match(/<spec>([\s\S]*?)<\/spec>/);
		const cwdMatch = block.match(/<cwd>([\s\S]*?)<\/cwd>/);

		if (!titleMatch || !specMatch) return;

		this.onGoalProposal({
			title: titleMatch[1].trim(),
			spec: specMatch[1].trim(),
			cwd: cwdMatch ? cwdMatch[1].trim() : undefined,
		});
	}

	/** Check an assistant message for a <role_proposal> block and fire the callback. */
	private _checkForRoleProposal(message: any): void {
		if (!this.onRoleProposal) return;

		let text = "";
		if (typeof message.content === "string") {
			text = message.content;
		} else if (Array.isArray(message.content)) {
			text = message.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join("");
		}
		if (!text) return;

		const match = text.match(/<role_proposal>([\s\S]*?)<\/role_proposal>/);
		if (!match) return;

		const block = match[1];
		const nameMatch = block.match(/<name>([\s\S]*?)<\/name>/);
		const labelMatch = block.match(/<label>([\s\S]*?)<\/label>/);
		const promptMatch = block.match(/<prompt>([\s\S]*?)<\/prompt>/);
		const toolsMatch = block.match(/<tools>([\s\S]*?)<\/tools>/);
		const accessoryMatch = block.match(/<accessory>([\s\S]*?)<\/accessory>/);

		if (!nameMatch || !labelMatch || !promptMatch) return;

		this.onRoleProposal({
			name: nameMatch[1].trim(),
			label: labelMatch[1].trim(),
			prompt: promptMatch[1].trim(),
			tools: toolsMatch ? toolsMatch[1].trim() : "",
			accessory: accessoryMatch ? accessoryMatch[1].trim() : "none",
		});
	}

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
				this._taskStartTime = Date.now();
				break;

			case "agent_end": {
				this.flushDeferredMessage();
				this._state.isStreaming = false;
				this._isAborting = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();

				// Notify the user that the task finished
				const elapsed = this._taskStartTime ? Date.now() - this._taskStartTime : 0;
				this._notifyTaskComplete(elapsed);
				this._taskStartTime = null;
				break;
			}

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
					// Check for goal/role proposal during streaming so preview syncs live
					this._checkForGoalProposal(event.message);
					this._checkForRoleProposal(event.message);
				}
				break;

			case "message_end":
				if (event.message) {
					if (event.message.role === "assistant") {
						// Check for goal/role proposal in assistant message
						this._checkForGoalProposal(event.message);
						this._checkForRoleProposal(event.message);

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

			case "tool_execution_update":
				// Store partial results from long-running tools (e.g., skill invocations)
				// so the UI can show real-time progress.
				if (event.toolCallId && event.partialResult) {
					if (!this._state.toolPartialResults) {
						this._state.toolPartialResults = {};
					}
					this._state.toolPartialResults = {
						...this._state.toolPartialResults,
						[event.toolCallId]: event.partialResult,
					};
					// Notify UI to re-render with partial results
					this.onWorkflowUpdate?.();
					this.emit(event);
					return; // skip default emit at end
				}
				break;

			case "tool_execution_end":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.delete(event.toolCallId);
					// Clean up partial result now that the tool is done
					if (this._state.toolPartialResults?.[event.toolCallId]) {
						const { [event.toolCallId]: _, ...rest } = this._state.toolPartialResults;
						this._state.toolPartialResults = Object.keys(rest).length > 0 ? rest : undefined;
					}
				}
				break;

			case "compaction_start":
			case "auto_compaction_start":
				// Don't set isStreaming — compaction uses its own blob animation
				this._isCompacting = true;
				// Add a placeholder message so compaction is visible in chat history
				this._addCompactingPlaceholder();
				// Normalize to compaction_start for UI subscribers
				if (event.type === "auto_compaction_start") {
					this.emit({ type: "compaction_start" } as any);
					return; // skip the default emit at the end
				}
				break;

			// The agent subprocess may send error responses with id:undefined
			// (upstream bug). These arrive as events rather than RPC responses.
			// Treat compact-related errors as compaction_end so the UI recovers.
			case "response":
				if (!event.success && event.error) {
					// Synthesize a compaction_end event so the blob animation ends
					this.emit({ type: "compaction_end", success: false, error: event.error });
				}
				break;

			case "compaction_end":
			case "auto_compaction_end": {
				this._isCompacting = false;
				this._usageStaleAfterCompaction = true;
				// Replace the placeholder with the final result message
				const filtered = this._state.messages.filter((m: any) => m.id !== "compacting_placeholder");
				const success = event.type === "compaction_end" ? event.success : !event.aborted;
				const tokensBefore = (event as any).tokensBefore;
				let resultText = "Context compacted.";
				if (tokensBefore) {
					const fmt = tokensBefore < 1000 ? `${tokensBefore}` : tokensBefore < 1_000_000 ? `${(tokensBefore / 1000).toFixed(1)}k` : `${(tokensBefore / 1_000_000).toFixed(1)}M`;
					resultText = `Context compacted from ${fmt} tokens.`;
				}
				const resultMsg = success
					? {
						role: "assistant" as const,
						content: [{ type: "text", text: resultText }],
						timestamp: Date.now(),
						id: `compact_done_${Date.now()}`,
					}
					: {
						role: "assistant" as const,
						content: [{ type: "text", text: `Compaction failed: ${(event as any).error || ((event as any).aborted ? "Compaction aborted" : "Unknown error")}` }],
						timestamp: Date.now(),
						id: `compact_err_${Date.now()}`,
					};
				this._state.messages = [...filtered, resultMsg as any];
				// Store the result message so it survives the server's messages refresh
				this._compactionSyntheticMessages = [
					...this._compactionSyntheticMessages.filter((m: any) => m.role === "user"),
					resultMsg,
				];
				// Normalize to compaction_end for UI subscribers
				if (event.type === "auto_compaction_end") {
					this.emit({ type: "compaction_end", success } as any);
					return; // skip the default emit at the end
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
