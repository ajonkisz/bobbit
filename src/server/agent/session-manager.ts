import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
import { GOAL_ASSISTANT_PROMPT } from "./goal-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt } from "./system-prompt.js";
import { generateSessionTitle } from "./title-generator.js";

export type SessionStatus = "starting" | "idle" | "streaming" | "terminated";

export interface SessionInfo {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	createdAt: number;
	lastActivity: number;
	clients: Set<WebSocket>;
	rpcClient: RpcBridge;
	eventBuffer: EventBuffer;
	unsubscribe: () => void;
	isCompacting: boolean;
	titleGenerated: boolean;
	goalId?: string;
	/** True if this is a goal-creation assistant session */
	goalAssistant?: boolean;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

export interface SessionManagerOptions {
	/** Override the path to pi-coding-agent cli.js */
	agentCliPath?: string;
	/** Path to a custom system prompt file */
	systemPromptPath?: string;
}

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	private store = new SessionStore();
	goalManager: GoalManager;

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
		this.goalManager = new GoalManager();
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		const persisted = this.store.getAll();
		if (persisted.length === 0) return;

		console.log(`[session-manager] Restoring ${persisted.length} session(s)...`);

		for (const ps of persisted) {
			// Skip if agent session file no longer exists — truly unrecoverable
			if (!fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Removing ${ps.id} — agent session file missing: ${ps.agentSessionFile}`);
				this.store.remove(ps.id);
				continue;
			}

			try {
				await this.restoreSession(ps);
				console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
			} catch (err) {
				// Keep session in the store — the .jsonl file is still on disk.
				// It will be retried on the next server restart.
				console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);

				// Add a dormant entry so the UI can still list it
				this.sessions.set(ps.id, {
					id: ps.id,
					title: ps.title,
					cwd: ps.cwd,
					status: "terminated",
					createdAt: ps.createdAt,
					lastActivity: ps.lastActivity,
					clients: new Set(),
					rpcClient: new RpcBridge({ cwd: ps.cwd }), // placeholder, not started
					eventBuffer: new EventBuffer(),
					unsubscribe: () => {},
					isCompacting: false,
					titleGenerated: true,
					goalId: ps.goalId,
				});
			}
		}
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const goal = ps.goalId ? this.goalManager.getGoal(ps.goalId) : undefined;
		const promptPath = assembleSystemPrompt(ps.id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: ps.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec: goal?.spec,
		});
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: ps.title !== "New session",
			goalId: ps.goalId,
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(ps.id, { lastActivity: session.lastActivity });

			if (event.type === "agent_start") {
				session.status = "streaming";
				this.store.update(ps.id, { wasStreaming: true });
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				this.store.update(ps.id, { wasStreaming: false });
				broadcast(session.clients, { type: "session_status", status: "idle" });
			}

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
		});

		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: ps.agentSessionFile },
			15_000,
		);
		if (!switchResp.success) {
			await rpcClient.stop();
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}

		session.status = "idle";
		this.sessions.set(ps.id, session);

		// If the agent was mid-turn when the server died, re-prompt it to continue
		if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			this.store.update(ps.id, { wasStreaming: false });
			rpcClient.prompt(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, goalAssistant?: boolean): Promise<SessionInfo> {
		const id = randomUUID();

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: agentArgs,
			env: { BOBBIT_SESSION_ID: id },
		};
		if (this.agentCliPath) {
			bridgeOptions.cliPath = this.agentCliPath;
		}

		if (goalAssistant) {
			// Goal assistant sessions get a special system prompt
			const promptPath = assembleSystemPrompt(id, {
				baseSystemPromptPath: undefined,
				cwd,
				goalSpec: GOAL_ASSISTANT_PROMPT,
				goalTitle: "Goal Creation Assistant",
				goalState: "active",
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			// Normal sessions: global base + AGENTS.md from cwd + goal spec
			const goal = goalId ? this.goalManager.getGoal(goalId) : undefined;
			const promptPath = assembleSystemPrompt(id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const now = Date.now();
		const session: SessionInfo = {
			id,
			title: goalAssistant ? "Goal Assistant" : "New session",
			cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: goalAssistant ? true : false,
			goalId,
			goalAssistant,
		};

		// Subscribe to agent events — broadcast to all connected clients
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			if (event.type === "agent_start") {
				session.status = "streaming";
				this.store.update(id, { wasStreaming: true });
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				this.store.update(id, { wasStreaming: false });
				broadcast(session.clients, { type: "session_status", status: "idle" });
			} else if (event.type === "auto_compaction_start") {
				session.isCompacting = true;
			} else if (event.type === "auto_compaction_end") {
				session.isCompacting = false;
				// Refresh messages and state for clients after auto-compaction
				if (!event.aborted) {
					this.refreshAfterCompaction(session);
				}
			}

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
		});

		session.unsubscribe = unsub;

		await rpcClient.start();
		session.status = "idle";

		this.sessions.set(id, session);

		// Capture the agent's session file path and persist
		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist session ${id}:`, err);
		});

		return session;
	}

	/**
	 * Create a delegate session — a real session that runs a task on behalf of a parent session.
	 * The delegate gets a system prompt built from AGENTS.md + instructions.
	 * After creation, the instructions are automatically sent as the first prompt.
	 * Returns the session info immediately (the prompt runs asynchronously).
	 */
	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();

		// Build the task spec: instructions + optional context
		let taskSpec = opts.instructions;
		if (opts.context && Object.keys(opts.context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(opts.context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}

		// assembleSystemPrompt handles AGENTS.md from cwd automatically
		const promptPath = assembleSystemPrompt(id, {
			baseSystemPromptPath: undefined, // No global prompt — delegate gets AGENTS.md only
			cwd: opts.cwd,
			goalSpec: taskSpec,
			goalTitle: "Delegate Task",
			goalState: "active",
		});

		const bridgeOptions: RpcBridgeOptions = { cwd: opts.cwd, env: { BOBBIT_SESSION_ID: id } };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";
		const session: SessionInfo = {
			id,
			title: `⚡ ${titleSummary}`,
			cwd: opts.cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			delegateOf: parentSessionId,
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			if (event.type === "agent_start") {
				session.status = "streaming";
				this.store.update(id, { wasStreaming: true });
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				this.store.update(id, { wasStreaming: false });
				broadcast(session.clients, { type: "session_status", status: "idle" });
			} else if (event.type === "auto_compaction_start") {
				session.isCompacting = true;
			} else if (event.type === "auto_compaction_end") {
				session.isCompacting = false;
				if (!event.aborted) this.refreshAfterCompaction(session);
			}

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
		});

		session.unsubscribe = unsub;
		await rpcClient.start();
		session.status = "idle";
		this.sessions.set(id, session);

		// Persist session metadata
		this.persistSessionMetadata(session).then(() => {
			this.store.update(id, { delegateOf: parentSessionId });
		}).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		});

		// Send the task prompt and wait for the agent to start streaming
		// so that waitForIdle() doesn't return immediately.
		await rpcClient.prompt(
			"Execute the task described in your system prompt. Follow the instructions carefully."
		);

		// Wait for agent_start event (so session.status becomes "streaming")
		await new Promise<void>((resolve) => {
			if (session.status === "streaming") { resolve(); return; }
			const timeout = setTimeout(() => { unsub2(); resolve(); }, 10_000);
			const unsub2 = rpcClient.onEvent((event: any) => {
				if (event.type === "agent_start") {
					clearTimeout(timeout);
					unsub2();
					resolve();
				}
			});
		});

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
	}

	/**
	 * Wait for a session to become idle (not streaming).
	 * Returns immediately if already idle.
	 * Rejects on timeout.
	 */
	waitForIdle(sessionId: string, timeoutMs = 600_000): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error("Session not found"));
		if (session.status === "idle") return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve();
				}
			});
		});
	}

	/**
	 * Get the final assistant output from a session's messages.
	 */
	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session) return "";

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return "";

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		// Collect text from all assistant messages
		const texts: string[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					texts.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) texts.push(block.text);
					}
				}
			}
		}
		return texts.join("\n\n");
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				broadcast(session.clients, { type: "messages", data: msgs.data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: st.data });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
	}

	private async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const stateResp = await session.rpcClient.getState();
		if (!stateResp.success || !stateResp.data?.sessionFile) {
			console.warn(`[session-manager] Could not get agent session file for ${session.id}`);
			return;
		}

		this.store.put({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			agentSessionFile: stateResp.data.sessionFile,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			goalId: session.goalId,
		});
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		goalAssistant?: boolean;
		delegateOf?: string;
	}> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: s.status,
			createdAt: s.createdAt,
			lastActivity: s.lastActivity,
			clientCount: s.clients.size,
			isCompacting: s.isCompacting,
			goalId: s.goalId,
			goalAssistant: s.goalAssistant,
			delegateOf: s.delegateOf,
		}));
	}

	setTitle(id: string, title: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.title = title;
		this.store.update(id, { title });
		broadcast(session.clients, { type: "session_title", sessionId: id, title });
		return true;
	}

	/**
	 * Generate a title for a session on the first user prompt.
	 * Called immediately when the user sends a message, not after the agent replies.
	 */
	tryGenerateTitleFromPrompt(sessionId: string, userText: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.titleGenerated) return;
		session.titleGenerated = true;

		// Fire-and-forget
		this.autoGenerateTitleFromText(session, userText).catch((err) => {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		});
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const title = await generateSessionTitle(messages);
		if (title) {
			session.title = title;
			this.store.update(session.id, { title });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
		}
	}

	async autoGenerateTitle(session: SessionInfo): Promise<void> {
		try {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp.success) return;

			const messages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(messages) || messages.length === 0) return;

			const title = await generateSessionTitle(messages);
			if (title) {
				session.title = title;
				this.store.update(session.id, { title });
				broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
			}
		} catch (err) {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		}
	}

	async terminateSession(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;

		session.unsubscribe();
		await session.rpcClient.stop();
		session.status = "terminated";

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();

		this.sessions.delete(id);
		this.store.remove(id);
		cleanupSessionPrompt(id);
		return true;
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it
		if (session.status === "terminated") {
			const ps = this.store.get(sessionId);
			if (ps && fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this.restoreSession(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the new one
						const revived = this.sessions.get(sessionId);
						if (revived) revived.clients.add(ws);
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);

		// Note: tool_execution_update events from the heartbeat will flow to
		// this client naturally via the broadcast in the event listener.
		// The message-list renders partial results from toolPartialResults,
		// so no event replay is needed — the next heartbeat (every 3s) will
		// populate the state.

		return true;
	}

	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.clients.delete(ws);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// If not streaming, nothing to abort
		if (session.status !== "streaming") return;

		// Try graceful abort first
		try {
			await session.rpcClient.abort();
		} catch {
			// Abort RPC itself may fail/timeout — proceed to force kill
		}

		// Wait for the agent to become idle
		const settled = await new Promise<boolean>((resolve) => {
			if (session.status !== "streaming") {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				unsub();
				resolve(false);
			}, gracePeriodMs);
			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve(true);
				}
			});
		});

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) {
				agentSessionFile = stateResp.data?.sessionFile;
			}
		} catch {
			// Process may be unresponsive — try the persisted store
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Emit agent_end so clients know streaming stopped
		session.status = "idle";
		broadcast(session.clients, { type: "event", data: { type: "agent_end", messages: [] } });
		broadcast(session.clients, { type: "session_status", status: "idle" });

		// Restart the agent process
		try {
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;

			const rpcClient = new RpcBridge(bridgeOptions);
			const unsub = rpcClient.onEvent((event: any) => {
				session.lastActivity = Date.now();
				this.store.update(id, { lastActivity: session.lastActivity });

				if (event.type === "agent_start") {
					session.status = "streaming";
					this.store.update(id, { wasStreaming: true });
					broadcast(session.clients, { type: "session_status", status: "streaming" });
				} else if (event.type === "agent_end") {
					session.status = "idle";
					this.store.update(id, { wasStreaming: false });
					broadcast(session.clients, { type: "session_status", status: "idle" });
				}

				session.eventBuffer.push(event);
				broadcast(session.clients, { type: "event", data: event });
			});

			await rpcClient.start();

			// Resume session if we have the session file
			if (agentSessionFile && fs.existsSync(agentSessionFile)) {
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: agentSessionFile },
					15_000,
				);
				if (!switchResp.success) {
					console.error(`[session-manager] switch_session failed after force abort: ${switchResp.error}`);
				}
			}

			// Swap in the new bridge
			session.rpcClient = rpcClient;
			session.unsubscribe = unsub;
			session.status = "idle";
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			session.status = "terminated";
			broadcast(session.clients, { type: "session_status", status: "terminated" });
		}
	}

	async shutdown(): Promise<void> {
		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the streaming state for each session so interrupted agents
		// can be re-prompted on the next startup.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			// Snapshot the current streaming state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending agent_end that hasn't flushed to disk yet.
			this.store.update(id, { wasStreaming: session.status === "streaming" });

			session.unsubscribe();
			await session.rpcClient.stop();
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this.sessions.delete(id);
		}
	}
}
