/**
 * Agent tool invocation tests — separated from tools-e2e.spec.ts because
 * these spawn real pi-coding-agent subprocesses, which need long timeouts
 * and a working API key. They are excluded from default E2E runs via
 * testIgnore in playwright-e2e.config.ts.
 *
 * Run explicitly with:
 *   npm run build:server && npx playwright test --config playwright-e2e.config.ts tests/e2e/agent-tools-e2e.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { readE2EToken, BASE, WS_BASE } from "./e2e-setup.js";

test.setTimeout(120_000);

const TOKEN = readE2EToken();

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

async function createSession(cwd?: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: cwd || process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

interface WsMsg { type: string; [key: string]: any }

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

function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) =>
		m.type === "event" &&
		m.data?.type === "tool_execution_start" &&
		(m.data?.toolName || "").toLowerCase() === lower;
}

function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}

// ═══════════════════════════════════════════════════════════════════════════
// Session lifecycle (streaming, idle, abort) — spawns real agent processes
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
// Agent tool invocations — serial to avoid overwhelming the server
// ═══════════════════════════════════════════════════════════════════════════

test.describe.serial("Agent tools", () => {
	let sessionId: string;

	test.beforeAll(async () => {
		sessionId = await createSession();

		for (let i = 0; i < 30; i++) {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			const data = await resp.json();
			if (data.status === "idle") break;
			await new Promise((r) => setTimeout(r, 500));
		}

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

	async function verifyToolUsed(prompt: string, toolName: string, timeoutMs = 90_000): Promise<void> {
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
});
