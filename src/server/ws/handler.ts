import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { SessionManager } from "../agent/session-manager.js";
import type { RateLimiter } from "../auth/rate-limit.js";
import { validateToken } from "../auth/token.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === 1) {
		ws.send(JSON.stringify(msg));
	}
}

function getClientIp(req: IncomingMessage): string {
	return req.socket.remoteAddress || "unknown";
}

export function handleWebSocketConnection(
	ws: WebSocket,
	sessionId: string,
	req: IncomingMessage,
	sessionManager: SessionManager,
	authToken: string,
	rateLimiter: RateLimiter,
): void {
	const ip = getClientIp(req);
	let authenticated = false;
	const clientId = randomUUID();

	// 5-second window to authenticate before disconnection
	const authTimeout = setTimeout(() => {
		if (!authenticated) {
			ws.close(4001, "Auth timeout");
		}
	}, 5000);

	ws.on("message", async (data) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			send(ws, { type: "error", message: "Invalid JSON", code: "INVALID_JSON" });
			return;
		}

		// First message must be auth
		if (!authenticated) {
			if (msg.type !== "auth") {
				ws.close(4002, "Auth required");
				return;
			}

			if (rateLimiter.isRateLimited(ip)) {
				ws.close(4003, "Rate limited");
				return;
			}

			if (!validateToken(msg.token, authToken)) {
				rateLimiter.recordFailure(ip);
				console.log(`[gateway] Auth failed from ${ip}`);
				send(ws, { type: "auth_failed" });
				ws.close(4004, "Invalid token");
				return;
			}

			clearTimeout(authTimeout);
			authenticated = true;

			const session = sessionManager.getSession(sessionId);
			if (!session) {
				send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
				ws.close(4005, "Session not found");
				return;
			}

			// Register client in session
			sessionManager.addClient(sessionId, ws);

			send(ws, { type: "auth_ok" });

			// Send current agent state
			try {
				const stateResponse = await session.rpcClient.getState();
				if (stateResponse.success) {
					send(ws, { type: "state", data: stateResponse.data });
				}
			} catch {
				// State not available yet — client will get events as they come
			}

			// Notify other clients that a new device connected
			const joinMsg: ServerMessage = { type: "client_joined", clientId };
			const joinData = JSON.stringify(joinMsg);
			for (const client of session.clients) {
				if (client !== ws && client.readyState === 1) {
					client.send(joinData);
				}
			}

			send(ws, { type: "session_status", status: session.status });
			send(ws, { type: "session_title", sessionId, title: session.title });
			return;
		}

		// Authenticated — route commands to agent
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
			return;
		}

		try {
			switch (msg.type) {
				case "prompt":
					await session.rpcClient.prompt(msg.text);
					break;
				case "steer":
					await session.rpcClient.steer(msg.text);
					break;
				case "follow_up":
					await session.rpcClient.followUp(msg.text);
					break;
				case "abort":
					await session.rpcClient.abort();
					break;
				case "set_model":
					await session.rpcClient.setModel(msg.provider, msg.modelId);
					break;
				case "compact":
					await session.rpcClient.compact();
					break;
				case "get_state": {
					const stateResp = await session.rpcClient.getState();
					if (stateResp.success) {
						send(ws, { type: "state", data: stateResp.data });
					}
					break;
				}
				case "get_messages": {
					const msgsResp = await session.rpcClient.getMessages();
					if (msgsResp.success) {
						send(ws, { type: "messages", data: msgsResp.data as unknown[] });
					}
					break;
				}
				case "set_title":
					sessionManager.setTitle(sessionId, msg.title);
					break;
				case "ping":
					send(ws, { type: "pong" });
					break;
				default:
					send(ws, { type: "error", message: "Unknown message type", code: "UNKNOWN_TYPE" });
			}
		} catch (err) {
			send(ws, { type: "error", message: String(err), code: "COMMAND_ERROR" });
		}
	});

	ws.on("close", () => {
		clearTimeout(authTimeout);
		if (authenticated) {
			sessionManager.removeClient(sessionId, ws);

			// Notify remaining clients
			const session = sessionManager.getSession(sessionId);
			if (session) {
				const leaveMsg: ServerMessage = { type: "client_left", clientId };
				const leaveData = JSON.stringify(leaveMsg);
				for (const client of session.clients) {
					if (client.readyState === 1) {
						client.send(leaveData);
					}
				}
			}
		}
	});

	ws.on("error", (err) => {
		console.error(`[gateway] WebSocket error from ${ip}:`, err.message);
	});
}
