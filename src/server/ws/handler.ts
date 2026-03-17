import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { SessionManager } from "../agent/session-manager.js";
import type { RateLimiter } from "../auth/rate-limit.js";
import { validateToken } from "../auth/token.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { WorkflowRunner, getWorkflow, listWorkflows } from "../workflows/index.js";
import type { TaskType, TaskState } from "../agent/task-store.js";

/** Get or restore the workflow runner for a session, caching it on the session object. */
function getRunner(session: any, sessionId: string): WorkflowRunner | undefined {
	let wr = session._workflowRunner as WorkflowRunner | undefined;
	if (!wr) {
		wr = WorkflowRunner.restore(sessionId, {
			onChange: (state) => broadcast(session.clients, { type: "workflow_state", data: state }),
		}) ?? undefined;
		if (wr) session._workflowRunner = wr;
	}
	return wr;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

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

			// Notify about compaction immediately (before any awaits) so the
			// client sets _isCompacting before a racing get_messages response.
			if (session.isCompacting) {
				send(ws, { type: "event", data: { type: "compaction_start" } });
			}

			// Send current agent state (don't block auth on this — fire async
			// so the client gets auth_ok immediately and can start rendering).
			session.rpcClient.getState().then((stateResponse) => {
				if (stateResponse.success) {
					send(ws, { type: "state", data: stateResponse.data });
				}
			}).catch(() => {
				// State not available yet — client will get events as they come
			});

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
					console.log(`[ws-handler] Prompt received: text="${msg.text?.substring(0, 50)}...", images=${msg.images?.length ?? 0}`);
					sessionManager.tryGenerateTitleFromPrompt(sessionId, msg.text);
					await session.rpcClient.prompt(msg.text, msg.images);
					break;
				case "steer":
					await session.rpcClient.steer(msg.text);
					break;
				case "follow_up":
					await session.rpcClient.followUp(msg.text);
					break;
				case "abort":
					sessionManager.forceAbort(sessionId).catch((err) => {
						send(ws, { type: "error", message: `Abort failed: ${err}`, code: "ABORT_ERROR" });
					});
					break;
				case "set_model":
					await session.rpcClient.setModel(msg.provider, msg.modelId);
					break;
				case "compact":
					// Fire-and-forget: don't block the WS message loop.
					// The async IIFE handles the full lifecycle.
					session.isCompacting = true;
					broadcast(session.clients, { type: "event", data: { type: "compaction_start" } });
					(async () => {
						try {
							console.log(`[ws-handler] Starting manual compact for session ${sessionId}`);
							const compactResult = await session.rpcClient.compact(120_000);
							console.log(`[ws-handler] Compact RPC resolved for session ${sessionId}`);
							session.isCompacting = false;
							// Send compaction_end BEFORE refreshing messages/state so
							// the client clears _isCompacting first and won't re-add
							// the placeholder when processing the refreshed messages.
							// Include tokensBefore so the UI can show how much was saved.
							const tokensBefore = compactResult?.data?.tokensBefore ?? null;
							broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: true, tokensBefore } });
							// Refresh messages and state (updated context tokens)
							await sessionManager.refreshAfterCompaction(session);
						} catch (err: any) {
							console.error(`[ws-handler] Compact failed for session ${sessionId}:`, err.message);
							session.isCompacting = false;
							broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: false, error: err.message } });
						}
					})().catch((err) => {
						console.error(`[ws-handler] Unexpected compact error for session ${sessionId}:`, err);
					});
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
				case "generate_title":
					sessionManager.autoGenerateTitle(session).catch((err) => {
						send(ws, { type: "error", message: `Title generation failed: ${err}`, code: "TITLE_GEN_ERROR" });
					});
					break;
				case "start_workflow": {
					const wf = getWorkflow(msg.workflowId);
					if (!wf) {
						send(ws, { type: "error", message: `Unknown workflow: ${msg.workflowId}`, code: "UNKNOWN_WORKFLOW" });
						break;
					}
					const runner = new WorkflowRunner(msg.workflowId, sessionId, {
						onChange: (state) => broadcast(session.clients, { type: "workflow_state", data: state }),
					});
					(session as any)._workflowRunner = runner;
					send(ws, { type: "workflow_state", data: runner.getState() });
					break;
				}
				case "workflow_status": {
					const wr = getRunner(session, sessionId);
					if (!wr) {
						send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" });
						break;
					}
					send(ws, { type: "workflow_state", data: wr.getState() });
					break;
				}
				case "workflow_advance": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.advancePhase();
					const st = wr.getState();
					if (st.status === "completed" && st.reportPath) {
						broadcast(session.clients, { type: "workflow_report", reportUrl: `/api/sessions/${sessionId}/workflow/report` });
					}
					break;
				}
				case "workflow_reset": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.resetToPhase(msg.phaseId, msg.context);
					break;
				}
				case "workflow_collect_artifact": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.collectArtifact(msg.name, msg.content, msg.mimeType);
					send(ws, { type: "workflow_state", data: wr.getState() });
					break;
				}
				case "workflow_set_context": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.setContext(msg.key, msg.value);
					send(ws, { type: "workflow_state", data: wr.getState() });
					break;
				}
				case "workflow_complete": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.complete();
					const st = wr.getState();
					broadcast(session.clients, { type: "workflow_completed", data: st });
					if (st.reportPath) {
						broadcast(session.clients, { type: "workflow_report", reportUrl: `/api/sessions/${sessionId}/workflow/report` });
					}
					break;
				}
				case "workflow_fail": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.fail(msg.reason);
					const st = wr.getState();
					broadcast(session.clients, { type: "workflow_completed", data: st });
					if (st.reportPath) {
						broadcast(session.clients, { type: "workflow_report", reportUrl: `/api/sessions/${sessionId}/workflow/report` });
					}
					break;
				}
				case "workflow_cancel": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.cancel();
					broadcast(session.clients, { type: "workflow_completed", data: wr.getState() });
					break;
				}
				case "workflow_synthesise_review": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }
					wr.synthesiseFindings();
					send(ws, { type: "workflow_state", data: wr.getState() });
					break;
				}
				case "workflow_batch": {
					const wr = getRunner(session, sessionId);
					if (!wr) { send(ws, { type: "error", message: "No active workflow", code: "NO_WORKFLOW" }); break; }

					// Separate batch-able ops (collect_artifact, set_context) from
					// state-transition ops (advance, complete) which persist on their own.
					const batchOps: Array<
						| { op: "collect_artifact"; name: string; content: string | Buffer; mimeType?: string }
						| { op: "set_context"; key: string; value: string }
					> = [];
					const transitionOps: Array<{ op: "advance" } | { op: "complete" }> = [];

					for (const op of msg.operations) {
						if (op.op === "collect_artifact" || op.op === "set_context") {
							batchOps.push(op as any);
						} else {
							transitionOps.push(op);
						}
					}

					// Apply batch ops with a single persist
					if (batchOps.length > 0) {
						wr.batchOperations(batchOps);
					}

					// Apply transition ops in order
					let didComplete = false;
					for (const op of transitionOps) {
						if (op.op === "advance") {
							wr.advancePhase();
						} else if (op.op === "complete") {
							wr.complete();
							didComplete = true;
						}
					}

					// Send state to requester
					const st = wr.getState();
					send(ws, { type: "workflow_state", data: st });

					// Broadcast completion and report if applicable
					if (didComplete) {
						broadcast(session.clients, { type: "workflow_completed", data: st });
						if (st.reportPath) {
							broadcast(session.clients, { type: "workflow_report", reportUrl: `/api/sessions/${sessionId}/workflow/report` });
						}
					} else if (transitionOps.some(op => op.op === "advance") && st.status === "completed" && st.reportPath) {
						broadcast(session.clients, { type: "workflow_report", reportUrl: `/api/sessions/${sessionId}/workflow/report` });
					}
					break;
				}
				case "task_create": {
					const task = sessionManager.taskManager.createTask(
						msg.goalId,
						msg.title,
						msg.taskType as TaskType,
						{ parentTaskId: msg.parentTaskId, spec: msg.spec, dependsOn: msg.dependsOn },
					);
					broadcast(session.clients, { type: "task_changed", task });
					break;
				}
				case "task_update": {
					const updates = { ...msg.updates, state: msg.updates.state as TaskState | undefined };
					const updated = sessionManager.taskManager.updateTask(msg.taskId, updates);
					if (updated) {
						const task = sessionManager.taskManager.getTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
				case "task_delete": {
					const task = sessionManager.taskManager.getTask(msg.taskId);
					if (task) {
						sessionManager.taskManager.deleteTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task: { ...task, _deleted: true } });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
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
