/** A message waiting in the server-side prompt queue */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	/** True if this message was already dispatched mid-turn via steer RPC.
	 *  Kept in queue so the UI shows "Sent" until the turn ends. */
	dispatched?: boolean;
	createdAt: number;
}

/** Client → Server messages over WebSocket */
export type ClientMessage =
	| { type: "auth"; token: string }
	| { type: "prompt"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; attachments?: unknown[] }
	| { type: "steer"; text: string }
	| { type: "follow_up"; text: string }
	| { type: "steer_queued"; messageId: string }
	| { type: "remove_queued"; messageId: string }
	| { type: "abort" }
	| { type: "retry" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "compact" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "set_title"; title: string }
	| { type: "generate_title" }
	| { type: "ping" }
	| { type: "start_workflow"; workflowId: string }
	| { type: "workflow_advance" }
	| { type: "workflow_reset"; phaseId: string; context?: string }
	| { type: "workflow_collect_artifact"; name: string; content: string; mimeType?: string }
	| { type: "workflow_set_context"; key: string; value: string }
	| { type: "workflow_complete" }
	| { type: "workflow_fail"; reason?: string }
	| { type: "workflow_cancel" }
	| { type: "workflow_status" }
	| { type: "workflow_batch"; operations: Array<
		| { op: "collect_artifact"; name: string; content: string; mimeType?: string }
		| { op: "set_context"; key: string; value: string }
		| { op: "advance" }
		| { op: "complete" }
	> }
	| { type: "workflow_synthesise_review" }
	| { type: "task_create"; goalId: string; title: string; taskType: string; parentTaskId?: string; spec?: string; dependsOn?: string[] }
	| { type: "task_update"; taskId: string; updates: { title?: string; spec?: string; state?: string; assignedSessionId?: string; dependsOn?: string[] } }
	| { type: "task_delete"; taskId: string };

/** Server → Client messages over WebSocket */
export type ServerMessage =
	| { type: "auth_ok" }
	| { type: "auth_failed" }
	| { type: "state"; data: unknown }
	| { type: "messages"; data: unknown[] }
	| { type: "event"; data: unknown }
	| { type: "client_joined"; clientId: string }
	| { type: "client_left"; clientId: string }
	| { type: "error"; message: string; code: string }
	| { type: "session_status"; status: string }
	| { type: "session_title"; sessionId: string; title: string }
	| { type: "pong" }
	| { type: "workflow_state"; data: unknown }
	| { type: "workflow_phase_changed"; data: unknown }
	| { type: "workflow_completed"; data: unknown }
	| { type: "workflow_report"; reportUrl: string }
	| { type: "cost_update"; sessionId: string; goalId?: string; taskId?: string; cost: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCost: number } }
	| { type: "queue_update"; sessionId: string; queue: QueuedMessage[] }
	| { type: "task_changed"; task: unknown }
	| { type: "tasks_list"; tasks: unknown[] };
