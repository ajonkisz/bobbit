import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
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

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
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
			// Skip if agent session file no longer exists
			if (!fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Skipping ${ps.id} — agent session file missing: ${ps.agentSessionFile}`);
				this.store.remove(ps.id);
				continue;
			}

			try {
				await this.restoreSession(ps);
				console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
			} catch (err) {
				console.error(`[session-manager] Failed to restore ${ps.id}:`, err);
				this.store.remove(ps.id);
			}
		}
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;

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
		};

		let titleGenerated = ps.title !== "New session";

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(ps.id, { lastActivity: session.lastActivity });

			if (event.type === "agent_start") {
				session.status = "streaming";
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				broadcast(session.clients, { type: "session_status", status: "idle" });

				if (!titleGenerated) {
					titleGenerated = true;
					this.autoGenerateTitle(session);
				}
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
	}

	async createSession(cwd: string, agentArgs?: string[]): Promise<SessionInfo> {
		const id = randomUUID();

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: agentArgs,
		};
		if (this.agentCliPath) {
			bridgeOptions.cliPath = this.agentCliPath;
		}
		if (this.systemPromptPath) {
			bridgeOptions.systemPromptPath = this.systemPromptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const now = Date.now();
		const session: SessionInfo = {
			id,
			title: "New session",
			cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
		};

		let titleGenerated = false;

		// Subscribe to agent events — broadcast to all connected clients
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			if (event.type === "agent_start") {
				session.status = "streaming";
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				broadcast(session.clients, { type: "session_status", status: "idle" });

				// Auto-generate title after the first agent turn completes
				if (!titleGenerated) {
					titleGenerated = true;
					this.autoGenerateTitle(session);
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

	/** Query the agent for its session file and save metadata to disk */
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
	}> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: s.status,
			createdAt: s.createdAt,
			lastActivity: s.lastActivity,
			clientCount: s.clients.size,
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
		return true;
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		session.clients.add(ws);
		return true;
	}

	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.clients.delete(ws);
		}
	}

	async shutdown(): Promise<void> {
		// Don't remove from store on shutdown — sessions should survive restart
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

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
