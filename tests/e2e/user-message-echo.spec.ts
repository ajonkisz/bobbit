/**
 * E2E test to verify user messages are echoed back via message_end events.
 * 
 * This test reproduces the "missing user message" bug by:
 * 1. Connecting to a session via WebSocket
 * 2. Sending a prompt
 * 3. Verifying a message_end event with role=user arrives
 * 4. Testing reconnection scenarios to see if messages survive
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { readE2EToken } from "./e2e-setup.js";

const BASE = "http://127.0.0.1:3099";
const WS_BASE = "ws://127.0.0.1:3099";
const TOKEN = readE2EToken();

async function createSession(): Promise<string> {
	const resp = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json() as { id: string };
	return data.id;
}

interface WsMsg {
	type: string;
	data?: any;
	[key: string]: any;
}

function connectWs(sessionId: string): Promise<{
	ws: WebSocket;
	messages: WsMsg[];
	waitForMessage: (predicate: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
		const messages: WsMsg[] = [];

		const waiters: Array<{
			predicate: (m: WsMsg) => boolean;
			resolve: (m: WsMsg) => void;
			reject: (e: Error) => void;
		}> = [];

		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString()) as WsMsg;
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].predicate(msg)) {
					waiters[i].resolve(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
		});

		ws.on("error", reject);

		const checkAuth = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(checkAuth);
				resolve({
					ws,
					messages,
					waitForMessage: (predicate, timeoutMs = 30_000) =>
						new Promise((res, rej) => {
							const existing = messages.find(predicate);
							if (existing) return res(existing);
							const timer = setTimeout(() => {
								rej(new Error(`Timed out waiting for message (${timeoutMs}ms). Got ${messages.length} messages: ${messages.map(m => m.type).join(", ")}`));
							}, timeoutMs);
							waiters.push({
								predicate,
								resolve: (m) => { clearTimeout(timer); res(m); },
								reject: rej,
							});
						}),
					send: (msg) => ws.send(JSON.stringify(msg)),
					close: () => ws.close(),
				});
			}
		}, 50);

		setTimeout(() => {
			clearInterval(checkAuth);
			reject(new Error("WS auth timeout"));
		}, 10_000);
	});
}

test.describe("User message echo", () => {
	test("prompt sends back a message_end event with role=user", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Send a prompt
			conn.send({ type: "prompt", text: "Hello, this is a test message" });

			// Wait for the user message_end event
			const userMsgEnd = await conn.waitForMessage(
				(m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "user",
				15_000,
			);

			expect(userMsgEnd.data.message.role).toBe("user");
			// Verify the text content matches
			const content = userMsgEnd.data.message.content;
			const textContent = Array.isArray(content)
				? content.find((c: any) => c.type === "text")?.text
				: content;
			expect(textContent).toContain("Hello, this is a test message");
		} finally {
			conn.close();
		}
	});

	test("user message appears in get_messages response after prompt", async () => {
		const sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Send a prompt
			conn.send({ type: "prompt", text: "Test message for get_messages" });

			// Wait for the user message_end to confirm it was processed
			await conn.waitForMessage(
				(m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "user",
				15_000,
			);

			// Now request messages (simulates what happens on reconnect)
			conn.send({ type: "get_messages" });

			const messagesResponse = await conn.waitForMessage(
				(m) => m.type === "messages",
				10_000,
			);

			const msgs = Array.isArray(messagesResponse.data)
				? messagesResponse.data
				: messagesResponse.data?.messages;
			expect(Array.isArray(msgs)).toBe(true);

			// Find our user message
			const userMsg = msgs.find((m: any) =>
				m.role === "user" && Array.isArray(m.content) &&
				m.content.some((c: any) => c.type === "text" && c.text?.includes("Test message for get_messages"))
			);
			expect(userMsg).toBeTruthy();
		} finally {
			conn.close();
		}
	});

	test("reconnect scenario: disconnect and reconnect, user message persists", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			// Send a prompt on first connection
			conn1.send({ type: "prompt", text: "Message before disconnect" });

			// Wait for user message echo
			await conn1.waitForMessage(
				(m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === "user",
				15_000,
			);

			// Disconnect
			conn1.close();

			// Small delay to simulate real reconnect
			await new Promise((r) => setTimeout(r, 500));

			// Reconnect
			const conn2 = await connectWs(sessionId);

			try {
				// Request messages (this is what RemoteAgent does on reconnect)
				conn2.send({ type: "get_messages" });

				const messagesResponse = await conn2.waitForMessage(
					(m) => m.type === "messages",
					10_000,
				);

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Message before disconnect"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			// conn1 already closed
		}
	});

	test("race condition: disconnect during prompt, reconnect gets messages", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			// Send prompt and immediately disconnect (simulate race condition)
			conn1.send({ type: "prompt", text: "Race condition test message" });
			
			// Give a tiny window for the server to receive the prompt
			await new Promise((r) => setTimeout(r, 100));
			
			// Disconnect before we receive the echo
			conn1.close();

			// Wait for the agent to process (the server-side prompt was already dispatched)
			await new Promise((r) => setTimeout(r, 2000));

			// Reconnect
			const conn2 = await connectWs(sessionId);

			try {
				conn2.send({ type: "get_messages" });

				const messagesResponse = await conn2.waitForMessage(
					(m) => m.type === "messages",
					10_000,
				);

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				// The user message should be in the server's message history
				// even though we disconnected before receiving the echo
				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Race condition test message"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			// conn1 already closed
		}
	});

	test("second client joining mid-stream gets user message via get_messages", async () => {
		const sessionId = await createSession();
		const conn1 = await connectWs(sessionId);

		try {
			// Send prompt on first client
			conn1.send({ type: "prompt", text: "Multi-client test" });

			// Wait for agent to start streaming
			await conn1.waitForMessage(
				(m) => m.type === "event" && m.data?.type === "agent_start",
				15_000,
			);

			// Connect second client (simulates tab reconnect)
			const conn2 = await connectWs(sessionId);

			try {
				// Second client requests messages
				conn2.send({ type: "get_messages" });

				const messagesResponse = await conn2.waitForMessage(
					(m) => m.type === "messages",
					10_000,
				);

				const msgs = Array.isArray(messagesResponse.data)
					? messagesResponse.data
					: messagesResponse.data?.messages;

				const userMsg = msgs.find((m: any) =>
					m.role === "user" && Array.isArray(m.content) &&
					m.content.some((c: any) => c.type === "text" && c.text?.includes("Multi-client test"))
				);
				expect(userMsg).toBeTruthy();
			} finally {
				conn2.close();
			}
		} finally {
			conn1.close();
		}
	});
});
