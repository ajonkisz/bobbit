import { test, expect } from "@playwright/test";
import { readE2EToken, BASE as GW_URL } from "./e2e-setup.js";

/**
 * E2E tests for gate dependency enforcement on team_spawn and team/prompt.
 *
 * When a workflowGateId is provided, the server must verify that all upstream
 * dependency gates have passed before allowing the spawn or prompt. If any
 * upstream gate is pending/failed, the server returns HTTP 409.
 *
 * Uses the `test-fast` workflow which has:
 *   design-doc (no deps) → implementation (depends on design-doc) → ready-to-merge (depends on implementation)
 */

function headers(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function createGoal(token: string, title: string) {
	const res = await fetch(`${GW_URL}/api/goals`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({
			title,
			cwd: process.cwd(),
			spec: "Gate dependency enforcement test",
			team: true,
			worktree: true,
			workflow: "test-fast",
		}),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{ id: string; [k: string]: unknown }>;
}

async function startTeam(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/start`, {
		method: "POST",
		headers: headers(token),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{ sessionId: string }>;
}

async function spawnAgent(
	token: string,
	goalId: string,
	body: { role: string; task: string; workflowGateId?: string },
) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/spawn`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json() };
}

async function promptAgent(
	token: string,
	goalId: string,
	body: { sessionId: string; message: string; workflowGateId?: string },
) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/team/prompt`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json() };
}

async function signalGate(token: string, goalId: string, gateId: string, content: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ content }),
	});
	return { status: res.status, data: await res.json() };
}

async function getGates(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/gates`, {
		headers: headers(token),
	});
	expect(res.ok).toBe(true);
	return res.json() as Promise<{ gates: Array<{ gateId: string; status: string }> }>;
}

async function waitForGatePassed(token: string, goalId: string, gateId: string, timeoutMs = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const { gates } = await getGates(token, goalId);
		const gate = gates.find(g => g.gateId === gateId);
		if (gate?.status === "passed") return;
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`Gate "${gateId}" did not pass within ${timeoutMs}ms`);
}

async function teardownTeam(token: string, goalId: string) {
	await fetch(`${GW_URL}/api/goals/${goalId}/team/teardown`, {
		method: "POST",
		headers: headers(token),
	}).catch(() => {});
}

async function deleteGoal(token: string, goalId: string) {
	await fetch(`${GW_URL}/api/goals/${goalId}`, {
		method: "DELETE",
		headers: headers(token),
	}).catch(() => {});
}

test.describe.serial("Gate Dependency Enforcement", () => {
	let token: string;
	const cleanupGoalIds: string[] = [];

	test.beforeAll(() => {
		token = readE2EToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupGoalIds) {
			await teardownTeam(token, id).catch(() => {});
		}
		await new Promise(r => setTimeout(r, 1000));
		for (const id of cleanupGoalIds) {
			await deleteGoal(token, id).catch(() => {});
		}
	});

	test("team/spawn rejected (409) when upstream gate not passed", async () => {
		const goal = await createGoal(token, "Spawn Reject Test");
		cleanupGoalIds.push(goal.id);
		await startTeam(token, goal.id);

		// Attempt to spawn for "implementation" gate — depends on "design-doc" which is pending
		const result = await spawnAgent(token, goal.id, {
			role: "coder",
			task: "Implement the feature",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(409);
		expect(result.data.error).toContain("Upstream gate");
	});

	test("team/spawn succeeds (201) when upstream gate passed", async () => {
		const goal = await createGoal(token, "Spawn Success Test");
		cleanupGoalIds.push(goal.id);
		await startTeam(token, goal.id);

		// Signal the design-doc gate so it passes
		const signalResult = await signalGate(token, goal.id, "design-doc", "# Design\nThis is the design doc.");
		expect([200, 201]).toContain(signalResult.status);

		// Wait for verification to complete (test-fast uses `echo ok`)
		await waitForGatePassed(token, goal.id, "design-doc");

		// Now spawning for "implementation" gate should succeed
		const result = await spawnAgent(token, goal.id, {
			role: "coder",
			task: "Implement the feature",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(201);
		expect(result.data.sessionId).toBeTruthy();
	});

	test("team/prompt rejected (409) when upstream gate not passed", async () => {
		const goal = await createGoal(token, "Prompt Reject Test");
		cleanupGoalIds.push(goal.id);
		await startTeam(token, goal.id);

		// Spawn an agent WITHOUT workflowGateId (backward compat, no gate check)
		const spawn = await spawnAgent(token, goal.id, {
			role: "coder",
			task: "Do some initial work",
		});
		expect(spawn.status).toBe(201);

		// Now prompt that agent with workflowGateId "implementation" while design-doc is pending
		const result = await promptAgent(token, goal.id, {
			sessionId: spawn.data.sessionId,
			message: "Now work on the implementation gate",
			workflowGateId: "implementation",
		});

		expect(result.status).toBe(409);
		expect(result.data.error).toContain("Upstream gate");
	});

	test("team/spawn without workflowGateId works (backward compat)", async () => {
		const goal = await createGoal(token, "Spawn No Gate Test");
		cleanupGoalIds.push(goal.id);
		await startTeam(token, goal.id);

		// Spawn with no workflowGateId — should succeed regardless of gate status
		const result = await spawnAgent(token, goal.id, {
			role: "coder",
			task: "Do generic work with no gate reference",
		});

		expect(result.status).toBe(201);
		expect(result.data.sessionId).toBeTruthy();
	});

	test("team/prompt without workflowGateId works (backward compat)", async () => {
		const goal = await createGoal(token, "Prompt No Gate Test");
		cleanupGoalIds.push(goal.id);
		await startTeam(token, goal.id);

		// Spawn an agent first
		const spawn = await spawnAgent(token, goal.id, {
			role: "coder",
			task: "Initial work",
		});
		expect(spawn.status).toBe(201);

		// Wait for the agent to become idle before prompting
		await new Promise(r => setTimeout(r, 2000));

		// Prompt without workflowGateId — should succeed
		const result = await promptAgent(token, goal.id, {
			sessionId: spawn.data.sessionId,
			message: "Continue working on the task",
		});

		// Accept either 200 (success) — the prompt is dispatched or queued
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);
	});
});
