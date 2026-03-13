/** Client → Server messages over WebSocket */
export type ClientMessage =
	| { type: "auth"; token: string }
	| { type: "prompt"; text: string; attachments?: unknown[] }
	| { type: "steer"; text: string }
	| { type: "follow_up"; text: string }
	| { type: "abort" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "compact" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "ping" };

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
	| { type: "pong" };
