/**
 * End-to-end tests for Bobbit agent tools and server APIs.
 *
 * Tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify:
 *   1. REST API endpoints (sessions, goals, tasks, artifacts, skills, health)
 *   2. WebSocket protocol (auth, ping/pong, session lifecycle, prompt dispatch)
 *   3. Agent tool invocations (Read, Write, Edit, Bash — verified via WS events)
 *
 * Run with: npm run build:server && npx playwright test --config playwright-e2e.config.ts tests/e2e/tools-e2e.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { readE2EToken, BASE, WS_BASE } from "./e2e-setup.js";

// ---------------------------------------------------------------------------
// Config — agent tool tests need much longer timeouts
// ---------------------------------------------------------------------------
test.setTimeout(120_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = readE2EToken();

/** Authenticated REST helper */
function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/** Create a session, return its ID */
async function createSession(cwd?: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: cwd || process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Delete a session (best-effort, for cleanup) */
async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

interface WsMsg { type: string; [key: string]: any }

/** Connect & authenticate a WebSocket to a session */
function connectWs(sessionId: string): Promise<{
	ws: WebSocket;
	messages: WsMsg[];
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];

		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: TOKEN })));
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					ws, messages,
					waitFor(pred, timeoutMs = 30_000) {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					send: (m) => ws.send(JSON.stringify(m)),
					close: () => ws.close(),
				});
			}
		}, 50);

		setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 15_000);
	});
}

/** Wait for a tool_execution_start event with the given tool name (case-insensitive) */
function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) =>
		m.type === "event" &&
		m.data?.type === "tool_execution_start" &&
		(m.data?.toolName || "").toLowerCase() === lower;
}

/** Wait for agent_end (turn finished) */
function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}

// Give the server a moment to be fully ready
test.beforeAll(async () => {
	await new Promise((r) => setTimeout(r, 1500));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. REST API — Health
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Health endpoint", () => {
	test("GET /api/health returns ok", async () => {
		const resp = await apiFetch("/api/health");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.status).toBe("ok");
		expect(typeof data.sessions).toBe("number");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. REST API — Sessions CRUD
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Sessions API", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("POST creates a session", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: process.cwd() }),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.status).toBeTruthy();
		sessionId = data.id;
	});

	test("GET lists sessions", async () => {
		sessionId = await createSession();
		const resp = await apiFetch("/api/sessions");
		expect(resp.status).toBe(200);
		const { sessions } = await resp.json();
		expect(Array.isArray(sessions)).toBe(true);
		expect(sessions.some((s: any) => s.id === sessionId)).toBe(true);
	});

	test("GET /:id returns a single session", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`);
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.id).toBe(sessionId);
		expect(data.cwd).toBeTruthy();
	});

	test("GET /:id returns 404 for non-existent", async () => {
		const resp = await apiFetch("/api/sessions/nonexistent-id-12345");
		expect(resp.status).toBe(404);
	});

	test("DELETE terminates a session", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(resp.status).toBe(200);
		const listResp = await apiFetch("/api/sessions");
		const { sessions } = await listResp.json();
		expect(sessions.some((s: any) => s.id === sessionId)).toBe(false);
		sessionId = "";
	});

	test("PATCH updates colorIndex", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ colorIndex: 7 }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect((await getResp.json()).colorIndex).toBe(7);
	});

	test("PATCH updates accessory", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ accessory: "crown" }),
		});
		expect(resp.status).toBe(200);
	});

	test("PATCH updates preview flag", async () => {
		sessionId = await createSession();
		const resp = await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ preview: true }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/sessions/${sessionId}`);
		expect((await getResp.json()).preview).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. REST API — Goals CRUD
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Goals API", () => {
	let goalId: string;
	test.afterEach(async () => { if (goalId) { await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {}); goalId = ""; } });

	test("POST creates a goal", async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "E2E test goal", cwd: process.cwd(), spec: "Test spec" }),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		expect(data.id).toBeTruthy();
		expect(data.title).toBe("E2E test goal");
		expect(data.state).toBe("todo");
		goalId = data.id;
	});

	test("GET lists goals", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "List test", cwd: process.cwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch("/api/goals");
		expect(resp.status).toBe(200);
		const { goals } = await resp.json();
		expect(goals.some((g: any) => g.id === goalId)).toBe(true);
	});

	test("GET /:id returns a single goal", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Get test", cwd: process.cwd(), spec: "spec here" }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`);
		expect(resp.status).toBe(200);
		expect((await resp.json()).spec).toBe("spec here");
	});

	test("PUT updates a goal", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Update test", cwd: process.cwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Updated title", state: "in-progress" }),
		});
		expect(resp.status).toBe(200);
		const getResp = await apiFetch(`/api/goals/${goalId}`);
		const data = await getResp.json();
		expect(data.title).toBe("Updated title");
		expect(data.state).toBe("in-progress");
	});

	test("DELETE removes a goal", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Delete test", cwd: process.cwd() }),
		});
		goalId = (await resp1.json()).id;
		const resp = await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
		expect(resp.status).toBe(200);
		expect((await apiFetch(`/api/goals/${goalId}`)).status).toBe(404);
		goalId = "";
	});

	test("creating a session under a goal auto-transitions to in-progress", async () => {
		const resp1 = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Integration test goal", cwd: process.cwd() }),
		});
		goalId = (await resp1.json()).id;
		expect((await (await apiFetch(`/api/goals/${goalId}`)).json()).state).toBe("todo");

		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ goalId, cwd: process.cwd() }),
		});
		const sessId = (await sessResp.json()).id;

		expect((await (await apiFetch(`/api/goals/${goalId}`)).json()).state).toBe("in-progress");
		await deleteSession(sessId);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. REST API — Tasks (under a team goal)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Tasks API", () => {
	let goalId: string;

	test.beforeEach(async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Task test goal " + Date.now(), cwd: process.cwd(), team: true }),
		});
		goalId = (await resp.json()).id;
	});
	test.afterEach(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
	});

	test("creates a non-implementation task without design-doc", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Refactor X", type: "refactor", spec: "Clean up" }),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.id).toBeTruthy();
		expect(task.title).toBe("Refactor X");
		expect(task.state).toBe("todo");
	});

	test("allows implementation task without artifact requirements", async () => {
		// Task creation no longer enforces artifact requirements
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Impl Y", type: "implementation" }),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts any task type string", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Custom type", type: "my-custom-type" }),
		});
		expect(resp.status).toBe(201);
	});

	test("GET lists tasks for a goal", async () => {
		await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "List test task", type: "refactor" }),
		});
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`);
		expect(resp.status).toBe(200);
		const { tasks } = await resp.json();
		expect(tasks.some((t: any) => t.title === "List test task")).toBe(true);
	});

	test("PUT /api/tasks/:id updates task state", async () => {
		const createResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Update me", type: "refactor" }),
		});
		const task = await createResp.json();

		// Task update uses /api/tasks/:id (not under /goals/)
		const resp = await apiFetch(`/api/tasks/${task.id}`, {
			method: "PUT",
			body: JSON.stringify({ state: "in-progress", spec: "Updated spec" }),
		});
		expect(resp.status).toBe(200);

		const getResp = await apiFetch(`/api/tasks/${task.id}`);
		const updated = await getResp.json();
		expect(updated.state).toBe("in-progress");
		expect(updated.spec).toBe("Updated spec");
	});

	test("DELETE /api/tasks/:id removes a task", async () => {
		const createResp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Delete me", type: "refactor" }),
		});
		const task = await createResp.json();

		const resp = await apiFetch(`/api/tasks/${task.id}`, { method: "DELETE" });
		expect(resp.status).toBe(200);

		const getResp = await apiFetch(`/api/tasks/${task.id}`);
		expect(getResp.status).toBe(404);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. REST API — Goal Artifacts CRUD
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Artifacts API", () => {
	let goalId: string;

	test.beforeEach(async () => {
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Artifact test " + Date.now(), cwd: process.cwd(), team: true }),
		});
		goalId = (await resp.json()).id;
	});
	test.afterEach(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
	});

	test("CRUD lifecycle", async () => {
		// Create
		const createResp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({ name: "test-doc", type: "design-doc", content: "# Design\nTest.", producedBy: "test" }),
		});
		expect(createResp.status).toBe(201);
		const artifact = await createResp.json();
		expect(artifact.id).toBeTruthy();
		expect(artifact.version).toBe(1);

		// List
		const listResp = await apiFetch(`/api/goals/${goalId}/artifacts`);
		expect(listResp.status).toBe(200);
		const { artifacts } = await listResp.json();
		expect(artifacts.length).toBe(1);

		// Get
		const getResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`);
		expect(getResp.status).toBe(200);
		expect((await getResp.json()).content).toContain("Test.");

		// Update (revision)
		const updateResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`, {
			method: "PUT",
			body: JSON.stringify({ content: "# Design v2\nRevised." }),
		});
		expect(updateResp.status).toBe(200);
		expect((await updateResp.json()).version).toBe(2);
	});

	test("returns 404 for non-existent artifact", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts/nonexistent`);
		expect(resp.status).toBe(404);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. REST API — Skills
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Skills API", () => {
	test("GET /api/skills returns built-in skills", async () => {
		const resp = await apiFetch("/api/skills");
		expect(resp.status).toBe(200);
		const { skills } = await resp.json();
		expect(Array.isArray(skills)).toBe(true);
		const ids = skills.map((s: any) => s.id);
		expect(ids).toContain("correctness-review");
		expect(ids).toContain("security-review");
		expect(ids).toContain("design-review");
		expect(ids).toContain("test-suite-report");
		for (const skill of skills) {
			expect(skill.name).toBeTruthy();
			expect(skill.description).toBeTruthy();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. REST API — Auth enforcement
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Auth enforcement", () => {
	test("rejects unauthenticated requests", async () => {
		expect((await fetch(`${BASE}/api/sessions`)).status).toBe(401);
		expect((await fetch(`${BASE}/api/goals`)).status).toBe(401);
		expect((await fetch(`${BASE}/api/skills`)).status).toBe(401);
	});

	test("rejects invalid token", async () => {
		const resp = await fetch(`${BASE}/api/sessions`, {
			headers: { Authorization: "Bearer invalid-token-12345" },
		});
		expect(resp.status).toBe(401);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. WebSocket — Auth & basic protocol
// ═══════════════════════════════════════════════════════════════════════════

test.describe("WebSocket protocol", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("authenticates and receives initial state", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			expect(conn.messages.some((m) => m.type === "auth_ok")).toBe(true);
			const status = await conn.waitFor((m) => m.type === "session_status");
			expect(typeof status.status).toBe("string");
			const title = await conn.waitFor((m) => m.type === "session_title");
			expect(title.sessionId).toBe(sessionId);
			const queue = await conn.waitFor((m) => m.type === "queue_update");
			expect(queue.queue).toEqual([]);
		} finally {
			conn.close();
		}
	});

	test("rejects invalid auth token", async () => {
		sessionId = await createSession();
		const result = await new Promise<string>((resolve) => {
			const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
			ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: "bad-token" })));
			ws.on("message", (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === "auth_failed") resolve("auth_failed");
			});
			ws.on("close", (code) => resolve(`closed:${code}`));
			setTimeout(() => resolve("timeout"), 5000);
		});
		expect(result).toBe("auth_failed");
	});

	test("ping/pong works", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "ping" });
			const pong = await conn.waitFor((m) => m.type === "pong");
			expect(pong.type).toBe("pong");
		} finally {
			conn.close();
		}
	});

	test("set_title updates session title", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "set_title", title: "My Custom Title" });
			const titleMsg = await conn.waitFor(
				(m) => m.type === "session_title" && m.title === "My Custom Title",
			);
			expect(titleMsg.title).toBe("My Custom Title");

			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			expect((await resp.json()).title).toBe("My Custom Title");
		} finally {
			conn.close();
		}
	});

	test("second client gets client_joined, first gets client_left on disconnect", async () => {
		sessionId = await createSession();
		const conn1 = await connectWs(sessionId);
		try {
			const conn2 = await connectWs(sessionId);
			const joinMsg = await conn1.waitFor((m) => m.type === "client_joined", 5000);
			expect(joinMsg.clientId).toBeTruthy();

			conn2.close();
			const leftMsg = await conn1.waitFor((m) => m.type === "client_left", 5000);
			expect(leftMsg.clientId).toBeTruthy();
		} finally {
			conn1.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. WebSocket — Session lifecycle (streaming, idle, abort)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Session lifecycle", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("prompt triggers streaming then idle", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with just the word OK and nothing else." });
			await conn.waitFor((m) => m.type === "session_status" && m.status === "streaming", 30_000);
			await conn.waitFor((m) => m.type === "session_status" && m.status === "idle", 90_000);
		} finally {
			conn.close();
		}
	});

	test("abort stops a streaming session", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({
				type: "prompt",
				text: "Write a very long essay about the complete history of computing, at least 5000 words.",
			});
			await conn.waitFor((m) => m.type === "session_status" && m.status === "streaming", 30_000);
			await new Promise((r) => setTimeout(r, 3000));
			conn.send({ type: "abort" });
			await conn.waitFor((m) => m.type === "session_status" && m.status === "idle", 30_000);
		} finally {
			conn.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Agent tool invocations — serial to avoid overwhelming the server
//
// Each test sends a targeted prompt and verifies the correct tool is invoked
// by watching for tool_execution_start events on the WebSocket.
// ═══════════════════════════════════════════════════════════════════════════

test.describe.serial("Agent tools", () => {
	let sessionId: string;

	// Reuse one session for all agent tool tests to reduce subprocess overhead.
	// Wait for the agent subprocess to be fully ready before running tests.
	test.beforeAll(async () => {
		sessionId = await createSession();

		// Wait for session to be idle (agent subprocess ready)
		for (let i = 0; i < 30; i++) {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			if (data.status === "idle") break;
			await new Promise((r) => setTimeout(r, 500));
		}

		// Warm up: send a trivial prompt and wait for it to complete.
		// This ensures the agent subprocess is fully initialized.
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with just: ready" });
			await conn.waitFor(
				(m) => m.type === "session_status" && m.status === "streaming",
				30_000,
			);
			await conn.waitFor(agentEndPredicate(), 60_000);
		} finally {
			conn.close();
		}

		// Wait for idle again
		for (let i = 0; i < 30; i++) {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			if (data.status === "idle") break;
			await new Promise((r) => setTimeout(r, 500));
		}
	});
	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId);
	});

	/** Helper: connect, send prompt, wait for tool + agent_end, disconnect */
	async function verifyToolUsed(prompt: string, toolName: string, timeoutMs = 90_000): Promise<void> {
		// Poll REST to ensure session is idle before connecting WS
		for (let i = 0; i < 60; i++) {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			if (data.status === "idle") break;
			await new Promise((r) => setTimeout(r, 1000));
		}

		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: prompt });

			const toolEvent = await conn.waitFor(toolStartPredicate(toolName), timeoutMs);
			expect(toolEvent.data.toolName.toLowerCase()).toBe(toolName.toLowerCase());

			await conn.waitFor(agentEndPredicate(), timeoutMs);
		} finally {
			conn.close();
		}
	}

	test("Bash tool", async () => {
		await verifyToolUsed(
			'Run this exact bash command and show me the output: echo BOBBIT_TOOL_TEST_OK_12345',
			"Bash",
		);
	});

	test("Write tool", async () => {
		const testFile = join(tmpdir(), `bobbit-e2e-write-${Date.now()}.txt`);
		try {
			await verifyToolUsed(
				`Use the Write tool to write the text "E2E_WRITE_TEST" to the file ${testFile}`,
				"Write",
			);
			expect(existsSync(testFile)).toBe(true);
			expect(readFileSync(testFile, "utf-8")).toContain("E2E_WRITE_TEST");
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});

	test("Read tool", async () => {
		const testFile = join(tmpdir(), `bobbit-e2e-read-${Date.now()}.txt`);
		writeFileSync(testFile, "READ_THIS_CONTENT_E2E\n", "utf-8");
		try {
			await verifyToolUsed(
				`Use the Read tool to read the file ${testFile} and tell me what it contains.`,
				"Read",
			);
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});

	test("Edit tool", async () => {
		const testFile = join(tmpdir(), `bobbit-e2e-edit-${Date.now()}.txt`);
		writeFileSync(testFile, "line1: ORIGINAL_VALUE\nline2: keep this\n", "utf-8");
		try {
			await verifyToolUsed(
				`Use the Edit tool to replace "ORIGINAL_VALUE" with "EDITED_VALUE" in the file ${testFile}. Do not use any other tool for the replacement.`,
				"Edit",
			);
			const content = readFileSync(testFile, "utf-8");
			expect(content).toContain("EDITED_VALUE");
			expect(content).not.toContain("ORIGINAL_VALUE");
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});

	// web_search, web_fetch, and delegate come from user extensions (~/.pi/extensions/)
	// which are not present in the sandboxed E2E test environment (BOBBIT_PI_DIR).
	// These tests are skipped here; they can be run manually against a full dev server.

	test.skip("web_search tool — requires user extensions", async () => {
		await verifyToolUsed(
			'Use the web_search tool to search for "Playwright test framework". Just do the search and briefly report results.',
			"web_search",
		);
	});

	test.skip("web_fetch tool — requires user extensions", async () => {
		await verifyToolUsed(
			"Use the web_fetch tool to fetch the URL https://httpbin.org/get and show me the response.",
			"web_fetch",
		);
	});

	test.skip("delegate tool — requires user extensions", async () => {
		await verifyToolUsed(
			'Use the delegate tool to run this task in a separate agent process: "Run echo DELEGATE_OK using bash and report the output." You must use the delegate tool.',
			"delegate",
			120_000,
		);
	});
});
