/**
 * E2E tests for team_abort REST endpoint.
 *
 * Tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify:
 *   1. Input validation (missing sessionId → 400)
 *   2. Team membership enforcement (non-member → 403)
 *   3. Session existence check (missing session → 403, since membership check comes first)
 *   4. Successful abort of a team agent
 *
 * Run with: npm run build:server && npx playwright test --config playwright-e2e.config.ts tests/e2e/team-abort.spec.ts
 */
import { test, expect } from "@playwright/test";
import { readE2EToken, BASE } from "./e2e-setup.js";

test.setTimeout(60_000);
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

/** Create a team-enabled goal, return its ID */
async function createGoal(title = "test-goal"): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ title, cwd: process.cwd(), team: true }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Create a session (not linked to any goal), return its ID */
async function createSession(): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Delete a session (best-effort cleanup) */
async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Delete a goal (best-effort cleanup) */
async function deleteGoal(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Start a team for a goal, returns the team lead session ID */
async function startTeam(goalId: string): Promise<string> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
	const data = await resp.json();
	if (resp.status >= 300) {
		throw new Error(`startTeam failed (${resp.status}): ${JSON.stringify(data)}`);
	}
	return data.sessionId;
}

// ── Validation tests ─────────────────────────────────────────────────

test.describe("team abort — validation", () => {
	let goalId: string;

	test.beforeAll(async () => {
		goalId = await createGoal("abort-validation");
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /team/abort returns 400 without sessionId", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing");
	});

	test("POST /team/abort returns 400 with empty body", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});
});

// ── Team membership tests ────────────────────────────────────────────

test.describe("team abort — membership enforcement", () => {
	let goalId: string;
	let nonTeamSessionId: string;

	test.beforeAll(async () => {
		goalId = await createGoal("abort-membership");
		nonTeamSessionId = await createSession(); // not part of any team
	});

	test.afterAll(async () => {
		await deleteSession(nonTeamSessionId);
		await deleteGoal(goalId);
	});

	test("POST /team/abort returns 403 for non-team session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: nonTeamSessionId }),
		});
		expect(resp.status).toBe(403);
		const data = await resp.json();
		expect(data.error).toContain("not a member");
	});

	test("POST /team/abort returns 403 for nonexistent session", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: "nonexistent-session-id" }),
		});
		// Gets 403 because it's not in the team agents list (membership check first)
		expect(resp.status).toBe(403);
	});
});

// ── Abort of a stuck team agent ──────────────────────────────────────

test.describe("team abort — stuck agent", () => {
	let goalId: string;
	let teamLeadId: string;

	test.beforeAll(async () => {
		goalId = await createGoal("abort-stuck");
		teamLeadId = await startTeam(goalId);
	});

	test.afterAll(async () => {
		await apiFetch(`/api/goals/${goalId}/team/teardown`, { method: "POST" }).catch(() => {});
		await deleteGoal(goalId);
	});

	test("POST /team/abort force-kills an agent stuck in a long bash sleep", async () => {
		// Spawn a role agent with a task that will make it run sleep 120
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({
				role: "coder",
				task: "Run this exact bash command: sleep 120. Do not do anything else.",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { sessionId: agentId } = await spawnResp.json();

		// Wait until the agent is streaming (processing the task)
		let streaming = false;
		for (let i = 0; i < 30; i++) {
			await new Promise(r => setTimeout(r, 1000));
			const statusResp = await apiFetch(`/api/sessions/${agentId}`);
			if (statusResp.status === 200) {
				const session = await statusResp.json();
				if (session.status === "streaming") { streaming = true; break; }
			}
		}
		expect(streaming).toBe(true);

		// Now force-abort — the agent is stuck in `sleep 120`
		const abortResp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
		expect(abortResp.status).toBe(200);
		const data = await abortResp.json();
		expect(data.ok).toBe(true);
		expect(data.status).toBe("idle");

		// Verify the agent session is alive and idle after the force-abort
		const statusResp = await apiFetch(`/api/sessions/${agentId}`);
		expect(statusResp.status).toBe(200);
		const session = await statusResp.json();
		expect(session.status).toBe("idle");

		// Verify the agent can accept new work after being aborted
		const promptResp = await apiFetch(`/api/goals/${goalId}/team/prompt`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId, message: "Reply with just the word OK" }),
		});
		expect(promptResp.status).toBe(200);
		const promptData = await promptResp.json();
		expect(promptData.ok).toBe(true);
		expect(promptData.status).toBe("dispatched");

		// Cleanup: dismiss the agent
		await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
	});

	test("POST /team/abort on an already-idle agent is a no-op", async () => {
		// Spawn a role agent with a trivial task
		const spawnResp = await apiFetch(`/api/goals/${goalId}/team/spawn`, {
			method: "POST",
			body: JSON.stringify({
				role: "coder",
				task: "Reply with just the word DONE and nothing else.",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { sessionId: agentId } = await spawnResp.json();

		// Wait for agent to finish its initial prompt and become idle
		let idle = false;
		for (let i = 0; i < 60; i++) {
			await new Promise(r => setTimeout(r, 1000));
			const statusResp = await apiFetch(`/api/sessions/${agentId}`);
			if (statusResp.status === 200) {
				const session = await statusResp.json();
				if (session.status === "idle") { idle = true; break; }
			}
		}
		expect(idle).toBe(true);

		// Abort an idle agent — should succeed as a no-op
		const abortResp = await apiFetch(`/api/goals/${goalId}/team/abort`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
		expect(abortResp.status).toBe(200);
		const data = await abortResp.json();
		expect(data.ok).toBe(true);
		expect(data.status).toBe("idle");

		// Cleanup
		await apiFetch(`/api/goals/${goalId}/team/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId: agentId }),
		});
	});
});

// ── Legacy /swarm/ path ──────────────────────────────────────────────

test.describe("team abort — legacy swarm path", () => {
	let goalId: string;

	test.beforeAll(async () => {
		goalId = await createGoal("abort-swarm-compat");
	});

	test.afterAll(async () => {
		await deleteGoal(goalId);
	});

	test("POST /swarm/abort works (backward compat)", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/swarm/abort`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		// Should get 400 (missing sessionId) — not 404 — proving the route matches
		expect(resp.status).toBe(400);
	});
});
