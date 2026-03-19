import { randomUUID } from "node:crypto";
import type { SessionManager, SessionInfo } from "./session-manager.js";
import type { GoalManager } from "./goal-manager.js";
import { createWorktree, cleanupWorktree } from "../workflows/git.js";
import { getRolePrompt, VALID_ROLES } from "./team-prompts.js";
import { TeamStore } from "./team-store.js";
import type { RoleStore } from "./role-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import { generateTeamName } from "./team-names.js";
import type { ColorStore } from "./color-store.js";
import type { TaskManager } from "./task-manager.js";


export interface TeamAgent {
	sessionId: string;
	role: string;
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
}

export interface TeamAgentInfo {
	sessionId: string;
	role: string;
	status: string;
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
}

export interface TeamState {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgentInfo[];
	maxConcurrent: number;
}

/** Internal tracking for a team associated with a goal. */
interface TeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgent[];
	maxConcurrent: number;
}



/**
 * Manages team goal lifecycles — team lead sessions and role agent sessions
 * with isolated git worktrees.
 */
export interface TeamManagerConfig {
	/** Color store for assigning unique palette indices to team sessions */
	colorStore: ColorStore;
	/** Task manager for looking up tasks assigned to sessions */
	taskManager: TaskManager;
	/** Role store for looking up role definitions (prompts, accessories, tools) */
	roleStore?: RoleStore;
}

export class TeamManager {
	private sessionManager: SessionManager;
	private config: TeamManagerConfig;
	private taskManager: TaskManager;
	private teams = new Map<string, TeamEntry>();
	private store: TeamStore;

	/** Reverse lookup: sessionId → goalId for quick dismissal. */
	private sessionToGoal = new Map<string, string>();

	constructor(sessionManager: SessionManager, config: TeamManagerConfig) {
		this.sessionManager = sessionManager;
		this.config = config;
		this.taskManager = config.taskManager;
		this.store = new TeamStore();
		this.restoreTeams();
	}

	/** Pick a palette index (0-19) not already used by any session, with randomisation. */
	private assignUniqueColor(sessionId: string): void {
		const PALETTE_SIZE = 20;
		const used = new Set<number>();
		for (const [, idx] of Object.entries(this.config.colorStore.getAll())) {
			used.add(idx);
		}
		// Collect available indices and pick one at random
		const available: number[] = [];
		for (let i = 0; i < PALETTE_SIZE; i++) {
			if (!used.has(i)) available.push(i);
		}
		const idx = available.length > 0
			? available[Math.floor(Math.random() * available.length)]
			: Math.floor(Math.random() * PALETTE_SIZE);
		this.config.colorStore.set(sessionId, idx);
	}

	/**
	 * Convert an in-memory TeamEntry to a PersistedTeamEntry for storage.
	 */
	private toPersistedEntry(entry: TeamEntry): PersistedTeamEntry {
		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: entry.agents.map((a) => ({
				sessionId: a.sessionId,
				role: a.role,
				worktreePath: a.worktreePath,
				branch: a.branch,
				task: a.task,
				createdAt: a.createdAt,
			})),
			maxConcurrent: entry.maxConcurrent,
		};
	}

	/**
	 * Persist the current state of a team entry to disk.
	 */
	private persistEntry(goalId: string): void {
		const entry = this.teams.get(goalId);
		if (entry) {
			this.store.put(this.toPersistedEntry(entry));
		}
	}

	/**
	 * Restore teams from disk persistence.
	 * Reconstructs the in-memory Maps from the persisted store.
	 */
	private restoreTeams(): void {
		const persisted = this.store.getAll();
		for (const p of persisted) {
			const entry: TeamEntry = {
				goalId: p.goalId,
				teamLeadSessionId: p.teamLeadSessionId,
				agents: p.agents.map((a) => ({
					sessionId: a.sessionId,
					role: a.role,
					worktreePath: a.worktreePath,
					branch: a.branch,
					task: a.task,
					createdAt: a.createdAt,
				})),
				maxConcurrent: p.maxConcurrent,
			};
			this.teams.set(p.goalId, entry);

			// Rebuild reverse lookup
			if (p.teamLeadSessionId) {
				this.sessionToGoal.set(p.teamLeadSessionId, p.goalId);
			}
			for (const agent of entry.agents) {
				this.sessionToGoal.set(agent.sessionId, p.goalId);
			}

			console.log(
				`[team-manager] Restored team for goal ${p.goalId} — team lead: ${p.teamLeadSessionId}, agents: ${entry.agents.length}`,
			);
		}
	}

	private get goalManager(): GoalManager {
		return this.sessionManager.goalManager;
	}

	/**
	 * Start a team for the given goal.
	 * Creates a Team Lead session and returns it.
	 */
	async startTeam(goalId: string): Promise<SessionInfo> {
		const goal = this.goalManager.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		if (!goal.team) {
			throw new Error(`Goal "${goal.title}" does not have team mode enabled`);
		}
		if (this.teams.has(goalId)) {
			throw new Error(`Team already active for goal: ${goalId}`);
		}

		// Use the goal's worktree/cwd for the team lead
		const cwd = goal.worktreePath || goal.cwd;

		// Build the Team Lead role prompt with structural placeholders only
		// Secrets (gateway URL, auth token, goal ID) are passed as env vars, NOT embedded in prompt text
		const roleStore = this.config.roleStore;
		const storedRole = roleStore?.get("team-lead");
		const teamLeadPromptTemplate = storedRole?.promptTemplate || getRolePrompt("team-lead") || "";
		const teamLeadPrompt = teamLeadPromptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
			.replace(/\{\{AGENT_ID\}\}/g, `team-lead-${goalId.slice(0, 8)}`);

		// Create the team lead session under the goal, with role prompt appended to goal spec
		const session = await this.sessionManager.createSession(cwd, undefined, goalId, false, {
			rolePrompt: teamLeadPrompt,
		});

		// Assign a unique color and title
		this.assignUniqueColor(session.id);
		const teamLeadName = await generateTeamName("team-lead");
		this.sessionManager.setTitle(session.id, `Team Lead: ${teamLeadName}`);
		session.titleGenerated = true;
		const teamLeadAccessory = storedRole?.accessory ?? "crown";
		this.sessionManager.updateSessionMeta(session.id, {
			role: "team-lead",
			teamGoalId: goalId,
			worktreePath: goal.worktreePath,
			accessory: teamLeadAccessory,
		});

		// Initialize team tracking
		const entry: TeamEntry = {
			goalId,
			teamLeadSessionId: session.id,
			agents: [],
			maxConcurrent: 5,
		};
		this.teams.set(goalId, entry);
		this.sessionToGoal.set(session.id, goalId);
		this.persistEntry(goalId);

		// Transition goal to in-progress if needed
		if (goal.state === "todo") {
			this.goalManager.updateGoal(goalId, { state: "in-progress" });
		}

		// Kick off the team lead with an initial prompt (same pattern as delegate sessions)
		session.rpcClient.prompt("Execute the task described in your system prompt. Follow the instructions carefully.").catch((err: any) => {
			console.error("[team-manager] Failed to send team lead kickoff prompt:", err);
		});

		console.log(`[team-manager] Started team for goal "${goal.title}" — team lead: ${session.id}`);
		return session;
	}

	/**
	 * Spawn a role agent for a team goal.
	 * Creates an isolated git worktree and a session with the role's system prompt.
	 * Sends the task as the first prompt.
	 */
	async spawnRole(
		goalId: string,
		role: string,
		task: string,
	): Promise<{ sessionId: string; worktreePath: string }> {
		// Validate role — check RoleStore first, then fall back to hardcoded list
		const roleStore = this.config.roleStore;
		const storedRoleDef = roleStore?.get(role);
		if (!storedRoleDef && !VALID_ROLES.includes(role)) {
			throw new Error(`Invalid role "${role}". Valid roles: ${VALID_ROLES.join(", ")}`);
		}

		if (role === 'team-lead') {
			throw new Error('Cannot spawn team-lead role via spawnRole — use startTeam() instead');
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Check concurrency limit
		if (entry.agents.length >= entry.maxConcurrent) {
			throw new Error(
				`Team for goal ${goalId} already has ${entry.agents.length} agents (max: ${entry.maxConcurrent})`,
			);
		}

		const goal = this.goalManager.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		if (!goal.repoPath) {
			throw new Error(`Goal "${goal.title}" has no repoPath — cannot create worktree for role agent`);
		}

		// Create a worktree for this role agent
		const shortId = randomUUID().slice(0, 8);
		const goalSlug = (goal.branch || goalId.slice(0, 8)).replace(/\//g, '-');
		const branchName = `goal-${goalSlug}-${role}-${shortId}`;
		const worktreeResult = createWorktree(goal.repoPath, branchName);

		try {
			// Build role system prompt — prefer RoleStore, fall back to hardcoded
			const agentId = `${role}-${shortId}`;
			const rolePromptTemplate = storedRoleDef?.promptTemplate || getRolePrompt(role) || "";
			const rolePrompt = rolePromptTemplate
				.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
				.replace(/\{\{AGENT_ID\}\}/g, agentId);

			// Read allowed tools from role definition (empty = all tools allowed)
			const allowedTools = storedRoleDef?.allowedTools ?? [];

			// Create the session with the role's worktree as cwd, role prompt appended to goal spec
			const session = await this.sessionManager.createSession(
				worktreeResult.worktreePath,
				undefined,
				goalId,
				false,
				{ rolePrompt, allowedTools },
			);

			// Assign a unique color and title
			this.assignUniqueColor(session.id);
			const roleName = await generateTeamName(role);
			const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
			this.sessionManager.setTitle(session.id, `${roleLabel}: ${roleName}`);
			session.titleGenerated = true;
			const roleAccessory = storedRoleDef?.accessory ?? "";
			this.sessionManager.updateSessionMeta(session.id, {
				role,
				teamGoalId: goalId,
				worktreePath: worktreeResult.worktreePath,
				accessory: roleAccessory,
			});

			// Track the agent
			const agent: TeamAgent = {
				sessionId: session.id,
				role,
				worktreePath: worktreeResult.worktreePath,
				branch: branchName,
				task,
				createdAt: Date.now(),
			};
			entry.agents.push(agent);
			this.sessionToGoal.set(session.id, goalId);
			this.persistEntry(goalId);

			// Send the task as the first prompt
			session.rpcClient.prompt(task).catch((err: any) => {
				console.error('[team-manager] Failed to send task prompt:', err);
			});

			// Subscribe to worker events to steer the team lead when the worker goes idle
			session.rpcClient.onEvent((event: any) => {
				if (event.type !== "agent_end") return;
				this.notifyTeamLead(goalId, session.id, role, agentId).catch((err) => {
					console.error("[team-manager] Failed to notify team lead:", err);
				});
			});

			console.log(
				`[team-manager] Spawned ${role} agent (${session.id}) for goal "${goal.title}" — worktree: ${worktreeResult.worktreePath}`,
			);

			return { sessionId: session.id, worktreePath: worktreeResult.worktreePath };
		} catch (err) {
			// Clean up the orphaned worktree on failure
			try {
				cleanupWorktree(goal.repoPath, worktreeResult.worktreePath, branchName, true);
				console.log(`[team-manager] Cleaned up orphaned worktree after spawnRole failure: ${worktreeResult.worktreePath}`);
			} catch (cleanupErr) {
				console.error(`[team-manager] Failed to clean up orphaned worktree ${worktreeResult.worktreePath}:`, cleanupErr);
			}
			throw err;
		}
	}

	/**
	 * Notify the team lead that a worker agent has gone idle.
	 * Sends a steer message with task context so the team lead can decide next steps.
	 */
	private async notifyTeamLead(goalId: string, workerSessionId: string, role: string, agentId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		// Look up tasks assigned to the worker
		const tasks = this.taskManager.getTasksForSession(workerSessionId);

		let message: string;
		if (tasks.length > 0) {
			const taskSummaries = tasks.map(t => `"${t.title}" (state: ${t.state})`).join(", ");
			message = `Agent ${agentId} (${role}) has finished. Tasks: ${taskSummaries}. Check tasks and decide next steps.`;
		} else {
			message = `Agent ${agentId} (${role}) has finished with no assigned tasks. Check tasks and decide next steps.`;
		}

		try {
			if (teamLeadSession.status === "streaming") {
				// Mid-turn: inject directly as a real-time steer interrupt
				await teamLeadSession.rpcClient.steer(message);
			} else {
				// Idle: enqueue as a steered prompt so it drains immediately
				this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true });
			}
			console.log(`[team-manager] Notified team lead for goal ${goalId} (status=${teamLeadSession.status}): ${message}`);
		} catch (err) {
			console.error(`[team-manager] Failed to notify team lead for goal ${goalId}:`, err);
		}
	}

	/**
	 * Notify the team lead when a task transitions to a terminal state.
	 * Called from the task transition REST endpoint so the team lead wakes up
	 * even if the worker continues with another task without going idle.
	 */
	notifyTeamLeadOfTaskCompletion(goalId: string, taskTitle: string, taskState: string): void {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		const message = `Task "${taskTitle}" transitioned to ${taskState}. Check tasks and decide next steps.`;

		if (teamLeadSession.status === "streaming") {
			teamLeadSession.rpcClient.steer(message).catch((err: any) => {
				console.error(`[team-manager] Failed to steer team lead on task completion for goal ${goalId}:`, err);
			});
		} else {
			this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true });
		}
		console.log(`[team-manager] Notified team lead of task completion for goal ${goalId}: ${taskTitle} → ${taskState}`);
	}

	/**
	 * Dismiss (terminate) a role agent session and clean up its worktree.
	 */
	async dismissRole(sessionId: string): Promise<boolean> {
		const goalId = this.sessionToGoal.get(sessionId);
		if (!goalId) {
			return false;
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			return false;
		}

		// Don't allow dismissing the team lead via this method
		if (entry.teamLeadSessionId === sessionId) {
			throw new Error("Cannot dismiss the team lead — use completeTeam() instead");
		}

		const agentIndex = entry.agents.findIndex((a) => a.sessionId === sessionId);
		if (agentIndex === -1) {
			return false;
		}

		const agent = entry.agents[agentIndex];

		// Terminate the session
		await this.sessionManager.terminateSession(sessionId);

		// Clean up the worktree
		const goal = this.goalManager.getGoal(goalId);
		if (goal?.repoPath && agent.worktreePath) {
			try {
				cleanupWorktree(goal.repoPath, agent.worktreePath, agent.branch, true);
				console.log(`[team-manager] Cleaned up worktree for ${agent.role} agent: ${agent.worktreePath}`);
			} catch (err) {
				console.error(`[team-manager] Failed to clean up worktree for ${agent.role} agent:`, err);
			}
		}

		// Remove from tracking
		entry.agents.splice(agentIndex, 1);
		this.sessionToGoal.delete(sessionId);
		this.persistEntry(goalId);

		console.log(`[team-manager] Dismissed ${agent.role} agent (${sessionId}) for goal ${goalId}`);
		return true;
	}

	/**
	 * List all active agents for a goal.
	 */
	listAgents(goalId: string): TeamAgentInfo[] {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return [];
		}

		return entry.agents.map((agent) => {
			const session = this.sessionManager.getSession(agent.sessionId);
			return {
				sessionId: agent.sessionId,
				role: agent.role,
				status: session?.status ?? "terminated",
				worktreePath: agent.worktreePath,
				branch: agent.branch,
				task: agent.task,
				createdAt: agent.createdAt,
			};
		});
	}

	/**
	 * Complete a team: dismiss all role agents but keep the team lead alive.
	 * The team lead remains active to present a report and await further instructions.
	 */
	async completeTeam(goalId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team completion:`, err);
			}
		}

		// Keep the team lead session alive — do NOT terminate it.
		// The team lead will present a report and await further instructions.

		// Update goal state
		this.goalManager.updateGoal(goalId, { state: "complete" });

		// Keep team tracking alive so the team lead can still be found
		// but persist the updated state (agents cleared)
		this.persistEntry(goalId);

		console.log(`[team-manager] Completed team for goal ${goalId} — team lead remains active: ${entry.teamLeadSessionId}`);
	}

	/**
	 * Fully tear down a team: dismiss all agents AND terminate the team lead.
	 * Use this when explicitly shutting down everything.
	 */
	async teardownTeam(goalId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team teardown:`, err);
			}
		}

		// Terminate the team lead session
		if (entry.teamLeadSessionId) {
			try {
				await this.sessionManager.terminateSession(entry.teamLeadSessionId);
			} catch (err) {
				console.error(`[team-manager] Error terminating team lead ${entry.teamLeadSessionId}:`, err);
			}
			this.sessionToGoal.delete(entry.teamLeadSessionId);
		}

		// Remove team tracking entirely
		this.teams.delete(goalId);
		this.store.remove(goalId);

		console.log(`[team-manager] Tore down team for goal ${goalId}`);
	}

	/**
	 * Get the full team state for a goal.
	 */
	getTeamState(goalId: string): TeamState | undefined {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return undefined;
		}

		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: this.listAgents(goalId),
			maxConcurrent: entry.maxConcurrent,
		};
	}
}
