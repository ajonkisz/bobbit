import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";

export type SessionStatus = "starting" | "idle" | "streaming" | "terminated";

export interface SessionInfo {
	id: string;
	cwd: string;
	status: SessionStatus;
	createdAt: number;
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

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
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

		const session: SessionInfo = {
			id,
			cwd,
			status: "starting",
			createdAt: Date.now(),
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
		};

		// Subscribe to agent events — broadcast to all connected clients
		const unsub = rpcClient.onEvent((event: any) => {
			if (event.type === "agent_start") {
				session.status = "streaming";
				broadcast(session.clients, { type: "session_status", status: "streaming" });
			} else if (event.type === "agent_end") {
				session.status = "idle";
				broadcast(session.clients, { type: "session_status", status: "idle" });
			}

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
		});

		session.unsubscribe = unsub;

		await rpcClient.start();
		session.status = "idle";

		this.sessions.set(id, session);
		return session;
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
	}

	listSessions(): Array<{
		id: string;
		cwd: string;
		status: string;
		createdAt: number;
		clientCount: number;
	}> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.id,
			cwd: s.cwd,
			status: s.status,
			createdAt: s.createdAt,
			clientCount: s.clients.size,
		}));
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
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			await this.terminateSession(id);
		}
	}
}
