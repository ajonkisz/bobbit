import { describe, it, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { TeamManager } from "../src/server/agent/team-manager.ts";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Clean up persisted team state to avoid cross-test contamination
const SWARM_STORE_FILE = path.join(os.homedir(), ".pi", "gateway-teams.json");
function clearTeamStore() { try { fs.unlinkSync(SWARM_STORE_FILE); } catch { /* ignore */ } }
clearTeamStore();

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockGoal {
	id: string;
	title: string;
	cwd: string;
	state: string;
	spec: string;
	createdAt: number;
	updatedAt: number;
	worktreePath?: string;
	branch?: string;
	repoPath?: string;
	team?: boolean;
	teamLeadSessionId?: string;
}

function createMockGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp/test-project",
		state: "todo",
		spec: "# Test Goal\nDo something",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/test",
		repoPath: "/tmp/test-repo",
		...overrides,
	};
}

function createMockSessionManager(goals: Map<string, MockGoal> = new Map()): any {
	const sessions = new Map<string, any>();
	let nextSessionId = 0;

	return {
		goalManager: {
			getGoal: (id: string) => goals.get(id),
			updateGoal: (id: string, updates: any) => {
				const g = goals.get(id);
				if (g) Object.assign(g, updates);
				return !!g;
			},
		},
		createSession: async (
			cwd: string,
			args?: string[],
			goalId?: string,
			goalAssistant?: boolean,
			opts?: any,
		) => {
			const id = `session-${nextSessionId++}`;
			const session = {
				id,
				title: "New session",
				cwd,
				status: "idle" as const,
				titleGenerated: false,
				goalId,
				rpcClient: { prompt: mock.fn(async () => {}) },
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		setTitle: (id: string, title: string) => {
			const s = sessions.get(id);
			if (s) s.title = title;
			return !!s;
		},
		updateSessionMeta: (id: string, updates: any) => {
			const s = sessions.get(id);
			if (s) Object.assign(s, updates);
			return !!s;
		},
		terminateSession: mock.fn(async (id: string) => {
			sessions.delete(id);
			return true;
		}),
		_sessions: sessions, // for test assertions
	};
}

const DEFAULT_CONFIG = {
	gatewayUrl: "https://10.5.0.2:3000",
	authToken: "test-token-123",
};

/** Create a TeamManager with a clean persisted state. */
function createTeamManager(sm: any, config = DEFAULT_CONFIG): InstanceType<typeof TeamManager> {
	clearTeamStore();
	return new TeamManager(sm, config);
}

// ---------------------------------------------------------------------------
// Tests: startTeam
// ---------------------------------------------------------------------------

describe("TeamManager", () => {
	describe("startTeam", () => {
		it("should create a team lead session for a valid team goal", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			assert.ok(session, "should return a session");
			assert.equal(session.id, "session-0");
			assert.ok(
				session.title.includes("Team Lead"),
				`title should include "Team Lead", got: ${session.title}`,
			);
			assert.ok(
				session.title.includes("Test Goal"),
				`title should include goal title, got: ${session.title}`,
			);
			assert.equal(session.titleGenerated, true);
		});

		it("should transition goal from todo to in-progress", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "todo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			assert.equal(goal.state, "in-progress");
		});

		it("should NOT transition goal that is already in-progress", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			assert.equal(goal.state, "in-progress");
		});

		it("should throw if goal not found", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.startTeam("nonexistent"), {
				message: /Goal not found/,
			});
		});

		it("should throw if goal does not have team mode enabled", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ team: false });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await assert.rejects(() => team.startTeam("goal-1"), {
				message: /does not have team mode enabled/,
			});
		});

		it("should throw if team is already active for the goal", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			await assert.rejects(() => team.startTeam("goal-1"), {
				message: /Team already active/,
			});
		});

		it("should use worktreePath from goal if available", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ worktreePath: "/tmp/goal-wt" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");
			assert.equal(session.cwd, "/tmp/goal-wt");
		});

		it("should fall back to goal.cwd when worktreePath is undefined", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ worktreePath: undefined, cwd: "/tmp/fallback" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");
			assert.equal(session.cwd, "/tmp/fallback");
		});

		it("should store session metadata with role and teamGoalId", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			assert.equal(session.role, "team-lead");
			assert.equal(session.teamGoalId, "goal-1");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: spawnRole — only validation/state (no real git)
	// ---------------------------------------------------------------------------

	describe("spawnRole (validation)", () => {
		it("should throw for an invalid role", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			await assert.rejects(() => team.spawnRole("goal-1", "hacker", "do stuff"), {
				message: /Invalid role/,
			});
		});

		it("should throw if no active team for the goal", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.spawnRole("goal-1", "coder", "code stuff"), {
				message: /No active team/,
			});
		});

		it("should throw if goal has no repoPath", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ repoPath: undefined });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			await assert.rejects(() => team.spawnRole("goal-1", "coder", "code stuff"), {
				message: /has no repoPath/,
			});
		});

		it("should reject team-lead role in spawnRole", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			await assert.rejects(() => team.spawnRole("goal-1", "team-lead", "lead stuff"), {
				message: /Cannot spawn team-lead/,
			});
		});

		it("should throw when concurrency limit reached", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Access the internal team entry to set maxConcurrent to 0
			// Since we can't easily mock createWorktree, we use a trick:
			// set maxConcurrent to 0 so even the first spawn fails
			const state = team.getTeamState("goal-1");
			assert.ok(state, "team state should exist");
			// We need to manipulate internals — use any cast
			(team as any).teams.get("goal-1")!.maxConcurrent = 0;

			await assert.rejects(() => team.spawnRole("goal-1", "coder", "code stuff"), {
				message: /already has 0 agents/,
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: dismissRole
	// ---------------------------------------------------------------------------

	describe("dismissRole", () => {
		it("should return false for an unknown session", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const result = await team.dismissRole("nonexistent");
			assert.equal(result, false);
		});

		it("should throw when trying to dismiss the team lead", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			await assert.rejects(() => team.dismissRole(session.id), {
				message: /Cannot dismiss the team lead/,
			});
		});

		it("should return false if agent not found in team entry", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually register a session → goal mapping that has no agent entry
			(team as any).sessionToGoal.set("orphan-session", "goal-1");

			const result = await team.dismissRole("orphan-session");
			assert.equal(result, false);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: listAgents
	// ---------------------------------------------------------------------------

	describe("listAgents", () => {
		it("should return empty array for non-existent team", () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const agents = team.listAgents("nonexistent");
			assert.deepEqual(agents, []);
		});

		it("should return empty array for team with no role agents", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			const agents = team.listAgents("goal-1");
			assert.deepEqual(agents, []);
		});

		it('should return "terminated" status for agents whose session is gone', async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject a fake agent entry whose session doesn't exist
			const entry = (team as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "dead-session",
				role: "coder",
				worktreePath: "/tmp/dead",
				branch: "dead-branch",
				task: "some task",
				createdAt: Date.now(),
			});

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].status, "terminated");
			assert.equal(agents[0].role, "coder");
			assert.equal(agents[0].task, "some task");
		});

		it("should return the session status for live agents", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject an agent entry whose session exists
			const fakeSession = {
				id: "live-session",
				status: "streaming",
				cwd: "/tmp/live",
			};
			sm._sessions.set("live-session", fakeSession);

			const entry = (team as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "live-session",
				role: "reviewer",
				worktreePath: "/tmp/live",
				branch: "live-branch",
				task: "review code",
				createdAt: Date.now(),
			});

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].status, "streaming");
			assert.equal(agents[0].role, "reviewer");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: getTeamState
	// ---------------------------------------------------------------------------

	describe("getTeamState", () => {
		it("should return undefined for non-existent team", () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const state = team.getTeamState("nonexistent");
			assert.equal(state, undefined);
		});

		it("should return full state for active team", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			const state = team.getTeamState("goal-1");
			assert.ok(state, "state should be defined");
			assert.equal(state!.goalId, "goal-1");
			assert.equal(state!.teamLeadSessionId, session.id);
			assert.equal(state!.maxConcurrent, 5);
			assert.deepEqual(state!.agents, []);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: completeTeam
	// ---------------------------------------------------------------------------

	describe("completeTeam", () => {
		it("should throw if no active team", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.completeTeam("nonexistent"), {
				message: /No active team/,
			});
		});

		it("should terminate team lead and update goal state", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			await team.completeTeam("goal-1");

			// Goal state should be "complete"
			assert.equal(goal.state, "complete");

			// Team should be removed
			assert.equal(team.getTeamState("goal-1"), undefined);

			// Team lead session should have been terminated
			assert.equal(sm._sessions.has(session.id), false);
		});

		it("should dismiss all role agents during completion", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject agents (to avoid needing real git)
			const entry = (team as any).teams.get("goal-1")!;
			const agentSession1 = {
				id: "agent-1",
				title: "Coder Agent",
				cwd: "/tmp/wt1",
				status: "idle",
				rpcClient: { prompt: async () => {} },
				clients: new Set(),
			};
			const agentSession2 = {
				id: "agent-2",
				title: "Tester Agent",
				cwd: "/tmp/wt2",
				status: "idle",
				rpcClient: { prompt: async () => {} },
				clients: new Set(),
			};
			sm._sessions.set("agent-1", agentSession1);
			sm._sessions.set("agent-2", agentSession2);

			entry.agents.push(
				{
					sessionId: "agent-1",
					role: "coder",
					worktreePath: "/tmp/wt1",
					branch: "branch-1",
					task: "code stuff",
					createdAt: Date.now(),
				},
				{
					sessionId: "agent-2",
					role: "tester",
					worktreePath: "/tmp/wt2",
					branch: "branch-2",
					task: "test stuff",
					createdAt: Date.now(),
				},
			);
			(team as any).sessionToGoal.set("agent-1", "goal-1");
			(team as any).sessionToGoal.set("agent-2", "goal-1");

			await team.completeTeam("goal-1");

			// All agents and team lead should be cleaned up
			assert.equal(sm._sessions.size, 0);
			assert.equal(team.getTeamState("goal-1"), undefined);
			assert.equal(goal.state, "complete");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: multiple teams for different goals
	// ---------------------------------------------------------------------------

	describe("multiple goals", () => {
		it("should manage independent teams for different goals", async () => {
			const goals = new Map<string, MockGoal>();
			const goal1 = createMockGoal({ id: "goal-1", title: "Goal 1" });
			const goal2 = createMockGoal({ id: "goal-2", title: "Goal 2" });
			goals.set(goal1.id, goal1);
			goals.set(goal2.id, goal2);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const s1 = await team.startTeam("goal-1");
			const s2 = await team.startTeam("goal-2");

			assert.notEqual(s1.id, s2.id);

			const state1 = team.getTeamState("goal-1");
			const state2 = team.getTeamState("goal-2");
			assert.ok(state1);
			assert.ok(state2);
			assert.equal(state1!.teamLeadSessionId, s1.id);
			assert.equal(state2!.teamLeadSessionId, s2.id);

			// Completing one team should not affect the other
			await team.completeTeam("goal-1");
			assert.equal(team.getTeamState("goal-1"), undefined);
			assert.ok(team.getTeamState("goal-2"));
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: persistence (TeamStore)
	// ---------------------------------------------------------------------------

	describe("persistence", () => {
		it("should persist team state and restore on new TeamManager instance", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			// Clear store and create first manager
			clearTeamStore();
			const team1 = new TeamManager(sm, DEFAULT_CONFIG);

			await team1.startTeam("goal-1");

			// Manually inject an agent to simulate spawnRole (no real git)
			const entry = (team1 as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "agent-session-1",
				role: "coder",
				worktreePath: "/tmp/wt",
				branch: "goal-test-coder-abc",
				task: "build something",
				createdAt: Date.now(),
			});
			(team1 as any).sessionToGoal.set("agent-session-1", "goal-1");
			(team1 as any).persistEntry("goal-1");

			// Create a new TeamManager (simulates server restart)
			const team2 = new TeamManager(sm, DEFAULT_CONFIG);

			const state = team2.getTeamState("goal-1");
			assert.ok(state, "should restore team state");
			assert.equal(state!.teamLeadSessionId, "session-0");
			assert.equal(state!.agents.length, 1);
			assert.equal(state!.agents[0].role, "coder");
			assert.equal(state!.agents[0].task, "build something");
		});

		it("should remove persisted state on completeTeam", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			clearTeamStore();
			const team1 = new TeamManager(sm, DEFAULT_CONFIG);
			await team1.startTeam("goal-1");
			await team1.completeTeam("goal-1");

			// New manager should not see the team
			const team2 = new TeamManager(sm, DEFAULT_CONFIG);
			assert.equal(team2.getTeamState("goal-1"), undefined);
		});
	});

	// ---------------------------------------------------------------------------
	// Integration tests: spawnRole + dismissRole with real git worktrees
	// ---------------------------------------------------------------------------

	describe("spawnRole + dismissRole (integration with git)", () => {
		let repoPath: string;
		let cleanup: () => void;

		function createTempGitRepo(): { repoPath: string; cleanup: () => void } {
			const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "team-test-"));
			execSync("git init", { cwd: tmp, stdio: "pipe" });
			execSync('git config user.email "test@test.com"', { cwd: tmp, stdio: "pipe" });
			execSync('git config user.name "Test"', { cwd: tmp, stdio: "pipe" });
			fs.writeFileSync(path.join(tmp, "README.md"), "# test");
			execSync("git add . && git commit -m init", { cwd: tmp, stdio: "pipe" });
			return {
				repoPath: tmp,
				cleanup: () => {
					// Also remove any sibling worktrees
					const parent = path.dirname(tmp);
					const basename = path.basename(tmp);
					try {
						for (const entry of fs.readdirSync(parent)) {
							if (entry.startsWith(`${basename}-wt-`)) {
								fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
							}
						}
					} catch {
						// ignore
					}
					fs.rmSync(tmp, { recursive: true, force: true });
				},
			};
		}

		beforeEach(() => {
			const repo = createTempGitRepo();
			repoPath = repo.repoPath;
			cleanup = repo.cleanup;
		});

		afterEach(() => {
			cleanup();
		});

		it("should create a worktree and session for a coder role", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			const result = await team.spawnRole("goal-1", "coder", "Implement feature X");

			// Session should have been created
			assert.ok(result.sessionId);
			assert.ok(result.worktreePath);

			// Worktree directory should exist
			assert.ok(fs.existsSync(result.worktreePath), `worktree should exist at ${result.worktreePath}`);

			// The file from the repo should be present in the worktree
			assert.ok(
				fs.existsSync(path.join(result.worktreePath, "README.md")),
				"README.md should exist in worktree",
			);

			// Agent listing should include the coder
			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].role, "coder");
			assert.equal(agents[0].task, "Implement feature X");

			// The prompt should have been called with the task
			const session = sm.getSession(result.sessionId);
			assert.ok(session, "session should exist");
			assert.equal(session.rpcClient.prompt.mock.callCount(), 1);
		});

		it("should set correct emoji title for each role", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			const result = await team.spawnRole("goal-1", "reviewer", "Review PR #42");
			const session = sm.getSession(result.sessionId);
			assert.ok(session);
			assert.ok(session.title.includes("🔍"), `reviewer should have 🔍 emoji, got: ${session.title}`);
			assert.ok(session.title.includes("Reviewer"), `title should include Reviewer, got: ${session.title}`);
		});

		it("should dismiss a role agent and clean up the worktree", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "tester", "Run test suite");

			// Verify worktree exists
			assert.ok(fs.existsSync(result.worktreePath));

			// Dismiss
			const dismissed = await team.dismissRole(result.sessionId);
			assert.equal(dismissed, true);

			// Worktree should be cleaned up
			assert.equal(
				fs.existsSync(result.worktreePath),
				false,
				"worktree should be removed after dismissal",
			);

			// Agent list should be empty
			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 0);

			// Session should be terminated
			assert.equal(sm._sessions.has(result.sessionId), false);
		});

		it("should spawn multiple role agents respecting concurrency limit", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Set low concurrency limit
			(team as any).teams.get("goal-1")!.maxConcurrent = 2;

			const r1 = await team.spawnRole("goal-1", "coder", "Task 1");
			const r2 = await team.spawnRole("goal-1", "tester", "Task 2");

			assert.equal(team.listAgents("goal-1").length, 2);

			// Third should fail
			await assert.rejects(() => team.spawnRole("goal-1", "reviewer", "Task 3"), {
				message: /already has 2 agents/,
			});

			// Clean up worktrees
			await team.dismissRole(r1.sessionId);
			await team.dismissRole(r2.sessionId);
		});

		it("should handle completeTeam with real worktrees", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			const r1 = await team.spawnRole("goal-1", "coder", "Code stuff");

			assert.ok(fs.existsSync(r1.worktreePath));

			await team.completeTeam("goal-1");

			// Worktree should be cleaned up
			assert.equal(fs.existsSync(r1.worktreePath), false, "worktree should be gone after completeTeam");
			assert.equal(goal.state, "complete");
			assert.equal(team.getTeamState("goal-1"), undefined);
		});

		it("should handle all valid roles: coder, reviewer, tester", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath,
				cwd: repoPath,
				worktreePath: repoPath,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// team-lead is not valid for spawnRole (it's the orchestrator started via startTeam)
			// coder, reviewer, tester are valid roles for spawning
			const roles = ["coder", "reviewer", "tester"];
			const results: { sessionId: string; worktreePath: string }[] = [];

			for (const role of roles) {
				const r = await team.spawnRole("goal-1", role, `${role} task`);
				results.push(r);
				assert.ok(fs.existsSync(r.worktreePath), `worktree for ${role} should exist`);
			}

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 3);

			// Clean up
			for (const r of results) {
				await team.dismissRole(r.sessionId);
			}
		});
	});
});
