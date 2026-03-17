import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for swarm and goal session lifecycle.
 *
 * Covers: creating a swarm goal, starting a swarm, letting it run,
 * ending/tearing down a swarm, creating manual sessions in a goal,
 * deleting sessions, starting a second swarm after ending a previous one, etc.
 *
 * Run with:
 *   npx playwright test tests/swarm-lifecycle.spec.ts --config tests/playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GW_URL = "http://localhost:3001";

function readGatewayToken(): string {
	const tokenPath = path.join(os.homedir(), ".pi", "gateway-token");
	const token = fs.readFileSync(tokenPath, "utf-8").trim();
	if (!token || token.length < 64) throw new Error("No valid gateway token found");
	return token;
}

function headers(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function apiCreateGoal(
	token: string,
	data: { title: string; cwd?: string; spec?: string; swarm?: boolean; worktree?: boolean },
) {
	const res = await fetch(`${GW_URL}/api/goals`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ cwd: process.cwd(), ...data }),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{
		id: string; title: string; cwd: string; state: string; spec: string;
		swarm?: boolean; worktreePath?: string; branch?: string; repoPath?: string;
	}>;
}

async function apiGetGoal(token: string, id: string) {
	const res = await fetch(`${GW_URL}/api/goals/${id}`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	return res.json() as Promise<{
		id: string; title: string; cwd: string; state: string; spec: string;
		swarm?: boolean; worktreePath?: string; branch?: string; repoPath?: string;
	}>;
}

async function apiUpdateGoal(token: string, id: string, updates: Record<string, unknown>) {
	const res = await fetch(`${GW_URL}/api/goals/${id}`, {
		method: "PUT",
		headers: headers(token),
		body: JSON.stringify(updates),
	});
	expect(res.ok).toBe(true);
}

async function apiDeleteGoal(token: string, id: string) {
	await fetch(`${GW_URL}/api/goals/${id}`, {
		method: "DELETE",
		headers: headers(token),
	});
}

async function apiListSessions(token: string) {
	const res = await fetch(`${GW_URL}/api/sessions`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.sessions as Array<{
		id: string; title: string; cwd: string; status: string;
		goalId?: string; role?: string; swarmGoalId?: string;
	}>;
}

async function apiCreateSession(token: string, body: Record<string, unknown> = {}) {
	const res = await fetch(`${GW_URL}/api/sessions`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return res.json() as Promise<{ id: string; cwd: string; goalId?: string }>;
}

async function apiDeleteSession(token: string, id: string) {
	await fetch(`${GW_URL}/api/sessions/${id}`, {
		method: "DELETE",
		headers: headers(token),
	});
}

async function apiGetSession(token: string, id: string) {
	const res = await fetch(`${GW_URL}/api/sessions/${id}`, { headers: headers(token) });
	return { status: res.status, data: res.ok ? await res.json() : null };
}

async function apiStartSwarm(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/start`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

async function apiGetSwarmState(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm`, { headers: headers(token) });
	return { status: res.status, data: res.ok ? await res.json() : null };
}

async function apiListSwarmAgents(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/agents`, { headers: headers(token) });
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.agents as Array<{
		sessionId: string; role: string; status: string;
		worktreePath: string; branch: string; task: string;
	}>;
}

async function apiSpawnRole(token: string, goalId: string, role: string, task: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/spawn`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ role, task }),
	});
	return { status: res.status, data: await res.json() };
}

async function apiDismissRole(token: string, goalId: string, sessionId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/dismiss`, {
		method: "POST",
		headers: headers(token),
		body: JSON.stringify({ sessionId }),
	});
	return { status: res.status, data: await res.json() };
}

async function apiCompleteSwarm(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/complete`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

async function apiTeardownSwarm(token: string, goalId: string) {
	const res = await fetch(`${GW_URL}/api/goals/${goalId}/swarm/teardown`, {
		method: "POST",
		headers: headers(token),
	});
	return { status: res.status, data: await res.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Swarm & Goal Session Lifecycle", () => {
	let token: string;
	const cleanupGoalIds: string[] = [];
	const cleanupSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test.afterAll(async () => {
		// Tear down any swarms first, then sessions, then goals
		for (const goalId of cleanupGoalIds) {
			await apiTeardownSwarm(token, goalId).catch(() => {});
		}
		for (const id of cleanupSessionIds) {
			await apiDeleteSession(token, id).catch(() => {});
		}
		// Small delay to let session terminations complete
		await new Promise((r) => setTimeout(r, 1000));
		for (const id of cleanupGoalIds) {
			await apiDeleteGoal(token, id).catch(() => {});
		}
	});

	// ── Swarm creation & basic lifecycle ──────────────────────────

	test("create a swarm goal, start swarm, verify team lead session", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Swarm Lifecycle Test",
			swarm: true,
			spec: "Test swarm lifecycle",
		});
		cleanupGoalIds.push(goal.id);

		expect(goal.swarm).toBe(true);
		expect(goal.state).toBe("todo");

		// Start the swarm — creates a team lead session
		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		expect(startResult.data.sessionId).toBeTruthy();
		cleanupSessionIds.push(startResult.data.sessionId);

		// Goal should transition to in-progress
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("in-progress");

		// Swarm state should show the team lead
		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.status).toBe(200);
		expect(swarmState.data.teamLeadSessionId).toBe(startResult.data.sessionId);
		expect(swarmState.data.agents).toHaveLength(0);

		// Team lead session should exist in session list
		const sessions = await apiListSessions(token);
		const teamLead = sessions.find((s) => s.id === startResult.data.sessionId);
		expect(teamLead).toBeTruthy();
		expect(teamLead!.role).toBe("team-lead");
		expect(teamLead!.swarmGoalId).toBe(goal.id);
	});

	test("cannot start a second swarm on the same goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Double Swarm Prevention",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const first = await apiStartSwarm(token, goal.id);
		expect(first.status).toBe(201);
		cleanupSessionIds.push(first.data.sessionId);

		// Second start should fail
		const second = await apiStartSwarm(token, goal.id);
		expect(second.status).toBe(400);
		expect(second.data.error).toContain("already active");
	});

	test("cannot start a swarm on a non-swarm goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Regular Goal No Swarm",
			swarm: false,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiStartSwarm(token, goal.id);
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("swarm mode");
	});

	// ── Spawning role agents ─────────────────────────────────────

	test("spawn role agents and verify they appear in swarm state", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Swarm Spawn Test",
			swarm: true,
			spec: "Test spawning agents",
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		// Spawn a coder agent
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write a hello world function");
		expect(coder.status).toBe(201);
		expect(coder.data.sessionId).toBeTruthy();
		expect(coder.data.worktreePath).toBeTruthy();
		cleanupSessionIds.push(coder.data.sessionId);

		// Spawn a reviewer agent
		const reviewer = await apiSpawnRole(token, goal.id, "reviewer", "Review the hello world function");
		expect(reviewer.status).toBe(201);
		cleanupSessionIds.push(reviewer.data.sessionId);

		// Verify swarm state shows both agents
		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.data.agents).toHaveLength(2);

		const roles = swarmState.data.agents.map((a: any) => a.role).sort();
		expect(roles).toEqual(["coder", "reviewer"]);

		// Verify agents appear in the agents list
		const agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(2);
		expect(agents.find((a) => a.role === "coder")).toBeTruthy();
		expect(agents.find((a) => a.role === "reviewer")).toBeTruthy();
	});

	test("spawn rejects invalid roles", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Invalid Role Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiSpawnRole(token, goal.id, "invalid-role", "Do something");
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("Invalid role");
	});

	test("spawn rejects team-lead role", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Lead Spawn Rejection",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiSpawnRole(token, goal.id, "team-lead", "Be a leader");
		expect(result.status).toBe(400);
		expect(result.data.error).toContain("team-lead");
	});

	// ── Dismissing role agents ───────────────────────────────────

	test("dismiss a role agent removes it from swarm state", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Dismiss Agent Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		// Spawn then dismiss a coder
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);

		const dismissResult = await apiDismissRole(token, goal.id, coder.data.sessionId);
		expect(dismissResult.status).toBe(200);
		expect(dismissResult.data.ok).toBe(true);

		// Agent should be gone from swarm state
		const agents = await apiListSwarmAgents(token, goal.id);
		expect(agents.find((a) => a.sessionId === coder.data.sessionId)).toBeUndefined();

		// Session should be terminated
		const session = await apiGetSession(token, coder.data.sessionId);
		if (session.data) {
			expect(session.data.status).toBe("terminated");
		}
	});

	test("cannot dismiss the team lead via dismiss endpoint", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Team Lead Dismiss Prevention",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const dismissResult = await apiDismissRole(token, goal.id, startResult.data.sessionId);
		expect(dismissResult.status).toBe(400);
		expect(dismissResult.data.error).toContain("team lead");
	});

	// ── Completing a swarm ───────────────────────────────────────

	test("completeSwarm dismisses agents but keeps team lead alive", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Swarm Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		const teamLeadId = startResult.data.sessionId;
		cleanupSessionIds.push(teamLeadId);

		// Spawn two agents
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);
		const tester = await apiSpawnRole(token, goal.id, "tester", "Test code");
		expect(tester.status).toBe(201);

		// Complete the swarm
		const result = await apiCompleteSwarm(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Goal should be complete
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("complete");

		// Agents should be gone
		const agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(0);

		// Team lead should still exist and be non-terminated
		const teamLeadSession = await apiGetSession(token, teamLeadId);
		expect(teamLeadSession.status).toBe(200);
		expect(teamLeadSession.data.status).not.toBe("terminated");
	});

	// ── Tearing down a swarm ─────────────────────────────────────

	test("teardownSwarm terminates everything including team lead", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Swarm Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		const teamLeadId = startResult.data.sessionId;

		// Spawn an agent
		const coder = await apiSpawnRole(token, goal.id, "coder", "Write code");
		expect(coder.status).toBe(201);

		// Teardown the swarm
		const result = await apiTeardownSwarm(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Swarm state should be gone
		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.status).toBe(404);

		// Team lead session should be terminated
		const teamLeadSession = await apiGetSession(token, teamLeadId);
		if (teamLeadSession.data) {
			expect(teamLeadSession.data.status).toBe("terminated");
		}
	});

	// ── Second swarm after teardown ──────────────────────────────

	test("can start a new swarm after tearing down the previous one", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Second Swarm Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// First swarm
		const first = await apiStartSwarm(token, goal.id);
		expect(first.status).toBe(201);
		const firstTeamLeadId = first.data.sessionId;

		// Spawn an agent and let it exist briefly
		const coder1 = await apiSpawnRole(token, goal.id, "coder", "First round task");
		expect(coder1.status).toBe(201);

		// Teardown the first swarm
		const teardownResult = await apiTeardownSwarm(token, goal.id);
		expect(teardownResult.status).toBe(200);

		// Reset goal state so we can start a new swarm
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		// Start a second swarm on the same goal
		const second = await apiStartSwarm(token, goal.id);
		expect(second.status).toBe(201);
		expect(second.data.sessionId).toBeTruthy();
		expect(second.data.sessionId).not.toBe(firstTeamLeadId);
		cleanupSessionIds.push(second.data.sessionId);

		// Second swarm should be functional
		const coder2 = await apiSpawnRole(token, goal.id, "coder", "Second round task");
		expect(coder2.status).toBe(201);
		cleanupSessionIds.push(coder2.data.sessionId);

		// Verify second swarm state
		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.status).toBe(200);
		expect(swarmState.data.teamLeadSessionId).toBe(second.data.sessionId);
		expect(swarmState.data.agents).toHaveLength(1);
	});

	// ── Second swarm after complete (not teardown) ───────────────

	test("can start a new swarm after completing the previous one (with teardown)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Second Swarm After Complete",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// First swarm
		const first = await apiStartSwarm(token, goal.id);
		expect(first.status).toBe(201);
		cleanupSessionIds.push(first.data.sessionId);

		// Complete (keeps team lead alive)
		await apiCompleteSwarm(token, goal.id);

		// The swarm entry still exists because team lead is alive.
		// We need to teardown to fully clear it before starting another.
		await apiTeardownSwarm(token, goal.id);

		// Reset goal state
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		// Start a second swarm
		const second = await apiStartSwarm(token, goal.id);
		expect(second.status).toBe(201);
		cleanupSessionIds.push(second.data.sessionId);

		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.status).toBe(200);
		expect(swarmState.data.teamLeadSessionId).toBe(second.data.sessionId);
	});

	// ── Manual sessions in a goal alongside swarm ────────────────

	test("create a manual session in a swarm goal (no swarm running)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Manual Session In Goal",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// Create a regular session under this goal (no swarm started)
		const session = await apiCreateSession(token, { goalId: goal.id });
		cleanupSessionIds.push(session.id);

		expect(session.goalId).toBe(goal.id);

		// Goal should transition to in-progress
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("in-progress");

		// Session should be in the session list under the goal
		const sessions = await apiListSessions(token);
		const found = sessions.find((s) => s.id === session.id);
		expect(found).toBeTruthy();
		expect(found!.goalId).toBe(goal.id);
	});

	test("delete a manual session in a goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Delete Manual Session Goal",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const session = await apiCreateSession(token, { goalId: goal.id });

		// Delete the session
		await apiDeleteSession(token, session.id);

		// Session should be terminated or gone
		const result = await apiGetSession(token, session.id);
		if (result.data) {
			expect(result.data.status).toBe("terminated");
		}
	});

	test("manual session and swarm coexist under the same goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Coexist Manual And Swarm",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// Create a manual session first
		const manual = await apiCreateSession(token, { goalId: goal.id });
		cleanupSessionIds.push(manual.id);

		// Start a swarm
		const swarmStart = await apiStartSwarm(token, goal.id);
		expect(swarmStart.status).toBe(201);
		cleanupSessionIds.push(swarmStart.data.sessionId);

		// Spawn a coder in the swarm
		const coder = await apiSpawnRole(token, goal.id, "coder", "Code something");
		expect(coder.status).toBe(201);
		cleanupSessionIds.push(coder.data.sessionId);

		// Both manual and swarm sessions should exist under the goal
		const sessions = await apiListSessions(token);
		const goalSessions = sessions.filter((s) => s.goalId === goal.id);
		expect(goalSessions.length).toBeGreaterThanOrEqual(2); // manual + team lead + coder

		// Manual session should NOT be in swarm agents list
		const agents = await apiListSwarmAgents(token, goal.id);
		expect(agents.find((a) => a.sessionId === manual.id)).toBeUndefined();

		// Tearing down swarm should not affect manual session
		await apiTeardownSwarm(token, goal.id);

		const manualAfter = await apiGetSession(token, manual.id);
		expect(manualAfter.status).toBe(200);
		expect(manualAfter.data.status).not.toBe("terminated");
	});

	// ── No swarm state for non-swarm goals ───────────────────────

	test("swarm state returns 404 for a regular goal", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Regular Goal Swarm 404",
			swarm: false,
		});
		cleanupGoalIds.push(goal.id);

		const state = await apiGetSwarmState(token, goal.id);
		expect(state.status).toBe(404);
	});

	test("swarm agents returns empty for a goal without a swarm", async () => {
		const goal = await apiCreateGoal(token, {
			title: "No Swarm Agents",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// No swarm started — agents list should be empty
		const agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(0);
	});

	// ── Swarm goal with worktree ─────────────────────────────────

	test("swarm goal creates a worktree and branch", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Swarm Worktree Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		// Swarm goals in a git repo should get a worktree
		expect(goal.worktreePath).toBeTruthy();
		expect(goal.branch).toBeTruthy();
		expect(goal.branch).toMatch(/^goal\//);
		expect(goal.repoPath).toBeTruthy();

		// The worktree directory should exist
		expect(fs.existsSync(goal.worktreePath!)).toBe(true);
	});

	// ── Edge cases ───────────────────────────────────────────────

	test("teardown a swarm that has no agents (only team lead)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Empty Swarm",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);

		// Teardown immediately — no agents spawned
		const result = await apiTeardownSwarm(token, goal.id);
		expect(result.status).toBe(200);
		expect(result.data.ok).toBe(true);

		// Swarm should be gone
		const swarmState = await apiGetSwarmState(token, goal.id);
		expect(swarmState.status).toBe(404);
	});

	test("complete a swarm with no agents (only team lead)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Empty Swarm",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const result = await apiCompleteSwarm(token, goal.id);
		expect(result.status).toBe(200);

		// Goal should be complete
		const updatedGoal = await apiGetGoal(token, goal.id);
		expect(updatedGoal.state).toBe("complete");

		// Team lead should still be alive
		const session = await apiGetSession(token, startResult.data.sessionId);
		expect(session.data.status).not.toBe("terminated");
	});

	test("teardown a nonexistent swarm returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Teardown Nonexistent",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiTeardownSwarm(token, goal.id);
		expect(result.status).toBe(400);
	});

	test("complete a nonexistent swarm returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Complete Nonexistent",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiCompleteSwarm(token, goal.id);
		expect(result.status).toBe(400);
	});

	test("spawn without active swarm returns 400", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Spawn No Swarm",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const result = await apiSpawnRole(token, goal.id, "coder", "Do work");
		expect(result.status).toBe(400);
	});

	// ── Full lifecycle: create → swarm → agents → complete → teardown → new swarm

	test("full lifecycle: create goal, swarm, spawn agents, complete, teardown, second swarm", async () => {
		// Step 1: Create a swarm goal
		const goal = await apiCreateGoal(token, {
			title: "Full Lifecycle Test",
			swarm: true,
			spec: "Complete lifecycle test",
		});
		cleanupGoalIds.push(goal.id);
		expect(goal.state).toBe("todo");

		// Step 2: Start first swarm
		const firstSwarm = await apiStartSwarm(token, goal.id);
		expect(firstSwarm.status).toBe(201);
		const firstTeamLeadId = firstSwarm.data.sessionId;

		const goalInProgress = await apiGetGoal(token, goal.id);
		expect(goalInProgress.state).toBe("in-progress");

		// Step 3: Spawn agents
		const coder = await apiSpawnRole(token, goal.id, "coder", "Implement feature");
		expect(coder.status).toBe(201);
		const tester = await apiSpawnRole(token, goal.id, "tester", "Write tests");
		expect(tester.status).toBe(201);

		// Verify all 2 agents in state
		let agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(2);

		// Step 4: Dismiss one agent
		await apiDismissRole(token, goal.id, coder.data.sessionId);
		agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(1);
		expect(agents[0].role).toBe("tester");

		// Step 5: Complete the swarm (dismisses remaining agents, keeps team lead)
		const completeResult = await apiCompleteSwarm(token, goal.id);
		expect(completeResult.status).toBe(200);

		const goalComplete = await apiGetGoal(token, goal.id);
		expect(goalComplete.state).toBe("complete");

		agents = await apiListSwarmAgents(token, goal.id);
		expect(agents).toHaveLength(0);

		// Team lead still alive
		const teamLeadAfterComplete = await apiGetSession(token, firstTeamLeadId);
		expect(teamLeadAfterComplete.data.status).not.toBe("terminated");

		// Step 6: Teardown completely
		const teardownResult = await apiTeardownSwarm(token, goal.id);
		expect(teardownResult.status).toBe(200);

		// Swarm gone
		const swarmAfterTeardown = await apiGetSwarmState(token, goal.id);
		expect(swarmAfterTeardown.status).toBe(404);

		// Team lead terminated
		const teamLeadAfterTeardown = await apiGetSession(token, firstTeamLeadId);
		if (teamLeadAfterTeardown.data) {
			expect(teamLeadAfterTeardown.data.status).toBe("terminated");
		}

		// Step 7: Reset goal state and start second swarm
		await apiUpdateGoal(token, goal.id, { state: "in-progress" });

		const secondSwarm = await apiStartSwarm(token, goal.id);
		expect(secondSwarm.status).toBe(201);
		expect(secondSwarm.data.sessionId).not.toBe(firstTeamLeadId);
		cleanupSessionIds.push(secondSwarm.data.sessionId);

		// Step 8: Verify second swarm works
		const coder2 = await apiSpawnRole(token, goal.id, "coder", "New implementation");
		expect(coder2.status).toBe(201);
		cleanupSessionIds.push(coder2.data.sessionId);

		const secondState = await apiGetSwarmState(token, goal.id);
		expect(secondState.status).toBe(200);
		expect(secondState.data.teamLeadSessionId).toBe(secondSwarm.data.sessionId);
		expect(secondState.data.agents).toHaveLength(1);
	});

	// ── Multiple goals with independent swarms ───────────────────

	test("independent swarms on different goals do not interfere", async () => {
		const goal1 = await apiCreateGoal(token, {
			title: "Independent Swarm A",
			swarm: true,
		});
		cleanupGoalIds.push(goal1.id);

		const goal2 = await apiCreateGoal(token, {
			title: "Independent Swarm B",
			swarm: true,
		});
		cleanupGoalIds.push(goal2.id);

		// Start swarms on both goals
		const swarm1 = await apiStartSwarm(token, goal1.id);
		expect(swarm1.status).toBe(201);
		cleanupSessionIds.push(swarm1.data.sessionId);

		const swarm2 = await apiStartSwarm(token, goal2.id);
		expect(swarm2.status).toBe(201);
		cleanupSessionIds.push(swarm2.data.sessionId);

		// Spawn agents on goal 1
		const coder1 = await apiSpawnRole(token, goal1.id, "coder", "Task for goal 1");
		expect(coder1.status).toBe(201);
		cleanupSessionIds.push(coder1.data.sessionId);

		// Spawn agents on goal 2
		const reviewer2 = await apiSpawnRole(token, goal2.id, "reviewer", "Task for goal 2");
		expect(reviewer2.status).toBe(201);
		cleanupSessionIds.push(reviewer2.data.sessionId);

		// Verify each swarm has its own agents
		const agents1 = await apiListSwarmAgents(token, goal1.id);
		expect(agents1).toHaveLength(1);
		expect(agents1[0].role).toBe("coder");

		const agents2 = await apiListSwarmAgents(token, goal2.id);
		expect(agents2).toHaveLength(1);
		expect(agents2[0].role).toBe("reviewer");

		// Teardown goal 1's swarm — should not affect goal 2
		await apiTeardownSwarm(token, goal1.id);

		const state2After = await apiGetSwarmState(token, goal2.id);
		expect(state2After.status).toBe(200);
		expect(state2After.data.agents).toHaveLength(1);
	});

	// ── Deleting a goal that had a swarm ─────────────────────────

	test("deleting a swarm goal does not crash (swarm not running)", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Delete Swarm Goal",
			swarm: true,
		});

		// Delete without starting a swarm
		await apiDeleteGoal(token, goal.id);

		// Goal should be gone
		const res = await fetch(`${GW_URL}/api/goals/${goal.id}`, { headers: headers(token) });
		expect(res.status).toBe(404);
	});

	// ── Session listing with swarm metadata ──────────────────────

	test("session list includes swarm role and goal metadata", async () => {
		const goal = await apiCreateGoal(token, {
			title: "Session Metadata Test",
			swarm: true,
		});
		cleanupGoalIds.push(goal.id);

		const startResult = await apiStartSwarm(token, goal.id);
		expect(startResult.status).toBe(201);
		cleanupSessionIds.push(startResult.data.sessionId);

		const coder = await apiSpawnRole(token, goal.id, "coder", "Implement feature");
		expect(coder.status).toBe(201);
		cleanupSessionIds.push(coder.data.sessionId);

		const sessions = await apiListSessions(token);

		const teamLead = sessions.find((s) => s.id === startResult.data.sessionId);
		expect(teamLead).toBeTruthy();
		expect(teamLead!.role).toBe("team-lead");
		expect(teamLead!.swarmGoalId).toBe(goal.id);
		expect(teamLead!.goalId).toBe(goal.id);

		const coderSession = sessions.find((s) => s.id === coder.data.sessionId);
		expect(coderSession).toBeTruthy();
		expect(coderSession!.role).toBe("coder");
		expect(coderSession!.swarmGoalId).toBe(goal.id);
	});
});
