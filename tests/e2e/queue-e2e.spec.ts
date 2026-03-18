/**
 * E2E tests for the server-authoritative prompt queue.
 *
 * These tests run against a real gateway (started by Playwright webServer).
 * They create sessions, connect via WebSocket, and verify queue behavior.
 *
 * Note: The sandboxed gateway spawns real agent subprocesses. We don't need
 * them to actually process prompts — we just need to verify the queue state
 * transitions. The agent will start processing but we check queue_update
 * messages that fire synchronously on enqueue/steer/remove.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

const BASE = "http://127.0.0.1:3099";
const WS_BASE = "ws://127.0.0.1:3099";
const TOKEN = readFileSync(join(homedir(), ".pi", "gateway-token"), "utf-8").trim();

interface QueueMsg {
	type: string;
	sessionId?: string;
	queue?: Array<{ id: string; text: string; isSteered: boolean }>;
}

/** Create a session via REST, returns session ID */
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

/** Connect a WebSocket to a session, authenticate, return helpers */
function connectWs(sessionId: string): Promise<{
	ws: WebSocket;
	messages: QueueMsg[];
	waitForMessage: (predicate: (m: QueueMsg) => boolean, timeoutMs?: number) => Promise<QueueMsg>;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
		const messages: QueueMsg[] = [];

		const waiters: Array<{
			predicate: (m: QueueMsg) => boolean;
			resolve: (m: QueueMsg) => void;
			reject: (e: Error) => void;
		}> = [];

		ws.on("message", (data) => {
			const msg = JSON.parse(data.toString()) as QueueMsg;
			messages.push(msg);

			// Check waiters
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

		// Wait for auth_ok
		const checkAuth = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(checkAuth);
				resolve({
					ws,
					messages,
					waitForMessage: (predicate, timeoutMs = 5000) => {
						// Check already-received messages first
						const existing = messages.find(predicate);
						if (existing) return Promise.resolve(existing);

						return new Promise((res, rej) => {
							const timer = setTimeout(() => {
								rej(new Error(`Timed out waiting for message (${timeoutMs}ms)`));
							}, timeoutMs);
							waiters.push({
								predicate,
								resolve: (m) => { clearTimeout(timer); res(m); },
								reject: rej,
							});
						});
					},
					send: (msg) => ws.send(JSON.stringify(msg)),
					close: () => ws.close(),
				});
			}
		}, 50);

		setTimeout(() => {
			clearInterval(checkAuth);
			reject(new Error("Auth timeout"));
		}, 10000);
	});
}

test.describe("Queue E2E", () => {
	let sessionId: string;

	test.beforeAll(async () => {
		// Wait a moment for server to be fully ready
		await new Promise((r) => setTimeout(r, 1000));
	});

	test("receives queue_update on connect (initially empty)", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			const queueMsg = await conn.waitForMessage((m) => m.type === "queue_update");
			expect(queueMsg.queue).toEqual([]);
			expect(queueMsg.sessionId).toBe(sessionId);
		} finally {
			conn.close();
		}
	});

	test("prompt when idle dispatches directly (queue stays empty)", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Wait for initial queue_update
			await conn.waitForMessage((m) => m.type === "queue_update");

			// Clear messages
			conn.messages.length = 0;

			// Send a prompt — agent is idle, should dispatch directly
			conn.send({ type: "prompt", text: "hello" });

			// Wait a bit — we should NOT get a queue_update with items
			// (the prompt bypasses the queue when idle+empty)
			await new Promise((r) => setTimeout(r, 1000));

			// Check: no queue_update with non-empty queue
			const queueUpdates = conn.messages.filter(
				(m) => m.type === "queue_update" && m.queue && m.queue.length > 0,
			);
			expect(queueUpdates.length).toBe(0);
		} finally {
			conn.close();
		}
	});

	test("prompt when busy gets queued, queue_update broadcast", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			// Wait for initial empty queue
			await conn.waitForMessage((m) => m.type === "queue_update");

			// Send first prompt to make agent busy
			conn.send({ type: "prompt", text: "first prompt" });

			// Wait for agent to start streaming
			await conn.waitForMessage((m) => m.type === "session_status" && (m as any).status === "streaming");

			// Now agent is busy — send another prompt
			conn.send({ type: "prompt", text: "queued message" });

			// Should get queue_update with the queued message
			const queueMsg = await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length > 0,
			);
			expect(queueMsg.queue!.length).toBe(1);
			expect(queueMsg.queue![0].text).toBe("queued message");
			expect(queueMsg.queue![0].isSteered).toBe(false);
		} finally {
			conn.close();
		}
	});

	test("steer_queued reorders queue", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitForMessage((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "working" });
			await conn.waitForMessage((m) => m.type === "session_status" && (m as any).status === "streaming");

			// Queue two messages
			conn.send({ type: "prompt", text: "msg A" });
			await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 1,
			);

			conn.send({ type: "prompt", text: "msg B" });
			const twoQueued = await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 2,
			);

			// Steer msg B (second in queue)
			const msgBId = twoQueued.queue![1].id;
			conn.send({ type: "steer_queued", messageId: msgBId });

			// Should get reordered queue: B first (steered), A second
			const reordered = await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined &&
					m.queue.length === 2 && m.queue[0].isSteered === true,
			);
			expect(reordered.queue![0].text).toBe("msg B");
			expect(reordered.queue![0].isSteered).toBe(true);
			expect(reordered.queue![1].text).toBe("msg A");
			expect(reordered.queue![1].isSteered).toBe(false);
		} finally {
			conn.close();
		}
	});

	test("remove_queued removes from queue", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

		try {
			await conn.waitForMessage((m) => m.type === "queue_update");

			// Make agent busy
			conn.send({ type: "prompt", text: "working" });
			await conn.waitForMessage((m) => m.type === "session_status" && (m as any).status === "streaming");

			// Queue a message
			conn.send({ type: "prompt", text: "to remove" });
			const queued = await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 1,
			);

			// Remove it
			conn.send({ type: "remove_queued", messageId: queued.queue![0].id });

			// Should get empty queue
			const empty = await conn.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 0,
			);
			expect(empty.queue).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("multi-client sync: both clients see queue updates", async () => {
		sessionId = await createSession();
		const conn1 = await connectWs(sessionId);
		const conn2 = await connectWs(sessionId);

		try {
			// Both get initial empty queue
			await conn1.waitForMessage((m) => m.type === "queue_update");
			await conn2.waitForMessage((m) => m.type === "queue_update");

			// Make agent busy via client 1
			conn1.send({ type: "prompt", text: "working" });
			await conn1.waitForMessage((m) => m.type === "session_status" && (m as any).status === "streaming");

			// Queue a message via client 1
			conn1.send({ type: "prompt", text: "from client 1" });

			// Both clients should see the queue update
			const q1 = await conn1.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 1,
			);
			const q2 = await conn2.waitForMessage(
				(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 1,
			);
			expect(q1.queue![0].text).toBe("from client 1");
			expect(q2.queue![0].text).toBe("from client 1");
		} finally {
			conn1.close();
			conn2.close();
		}
	});
	test("queue drains after agent finishes turn", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);

	try {
		await conn.waitForMessage((m) => m.type === "queue_update");

		// Send first prompt to make agent busy
		conn.send({ type: "prompt", text: "say hello" });
		await conn.waitForMessage((m) => m.type === "session_status" && (m as any).status === "streaming");

		// Queue a second message while busy
		conn.send({ type: "prompt", text: "queued follow-up" });
		await conn.waitForMessage(
			(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 1,
		);

		// Wait for agent to finish first turn — queue should drain
		// The drain dequeues the message and dispatches it, so we get
		// a queue_update with empty queue
		const drained = await conn.waitForMessage(
			(m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === 0,
			30_000, // agent turn can take a while
		);
		expect(drained.queue).toEqual([]);

		// Agent should go streaming again (processing the drained message)
		// We already saw it go streaming for the first prompt, so we need
		// to see idle then streaming again. The drain sets status to streaming
		// optimistically, so we should see another streaming status.
	} finally {
		conn.close();
	}
	});
});
