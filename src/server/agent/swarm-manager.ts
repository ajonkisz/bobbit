import { randomUUID } from "node:crypto";
import type { SessionManager, SessionInfo } from "./session-manager.js";
import type { GoalManager } from "./goal-manager.js";
import { createWorktree, cleanupWorktree } from "../workflows/git.js";
import { getRolePrompt, VALID_ROLES } from "./swarm-prompts.js";
import { SwarmStore } from "./swarm-store.js";
import type { PersistedSwarmEntry } from "./swarm-store.js";
import { generateSwarmName } from "./swarm-names.js";
import type { ColorStore } from "./color-store.js";
import type { TaskManager } from "./task-manager.js";


export interface SwarmAgent {
	sessionId: string;
	role: string;
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
}

export interface SwarmAgentInfo {
	sessionId: string;
	role: string;
	status: string;
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
}

export interface SwarmState {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: SwarmAgentInfo[];
	maxConcurrent: number;
}

/** Internal tracking for a swarm associated with a goal. */
interface SwarmEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: SwarmAgent[];
	maxConcurrent: number;
}



/**
 * Manages swarm goal lifecycles — team lead sessions and role agent sessions
 * with isolated git worktrees.
 */
export interface SwarmManagerConfig {
	/** Base URL of the gateway (e.g. "https://10.5.0.2:3000") */
	gatewayUrl: string;
	/** Auth token for the gateway REST API */
	authToken: string;
	/** Color store for assigning unique palette indices to swarm sessions */
	colorStore: ColorStore;
	/** Task manager for looking up tasks assigned to sessions */
	taskManager: TaskManager;
}

export class SwarmManager {
	private sessionManager: SessionManager;
	private config: SwarmManagerConfig;
	private taskManager: TaskManager;
	private swarms = new Map<string, SwarmEntry>();
	private store: SwarmStore;

	/** Reverse lookup: sessionId → goalId for quick dismissal. */
	private sessionToGoal = new Map<string, string>();

	constructor(sessionManager: SessionManager, config: SwarmManagerConfig) {
		this.sessionManager = sessionManager;
		this.config = config;
		this.taskManager = config.taskManager;
		this.store = new SwarmStore();
		this.restoreSwarms();
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
	 * Convert an in-memory SwarmEntry to a PersistedSwarmEntry for storage.
	 */
	private toPersistedEntry(entry: SwarmEntry): PersistedSwarmEntry {
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
	 * Persist the current state of a swarm entry to disk.
	 */
	private persistEntry(goalId: string): void {
		const entry = this.swarms.get(goalId);
		if (entry) {
			this.store.put(this.toPersistedEntry(entry));
		}
	}

	/**
	 * Restore swarms from disk persistence.
	 * Reconstructs the in-memory Maps from the persisted store.
	 */
	private restoreSwarms(): void {
		const persisted = this.store.getAll();
		for (const p of persisted) {
			const entry: SwarmEntry = {
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
			this.swarms.set(p.goalId, entry);

			// Rebuild reverse lookup
			if (p.teamLeadSessionId) {
				this.sessionToGoal.set(p.teamLeadSessionId, p.goalId);
			}
			for (const agent of entry.agents) {
				this.sessionToGoal.set(agent.sessionId, p.goalId);
			}

			console.log(
				`[swarm-manager] Restored swarm for goal ${p.goalId} — team lead: ${p.teamLeadSessionId}, agents: ${entry.agents.length}`,
			);
		}
	}

	private get goalManager(): GoalManager {
		return this.sessionManager.goalManager;
	}

	/**
	 * Start a swarm for the given goal.
	 * Creates a Team Lead session and returns it.
	 */
	async startSwarm(goalId: string): Promise<SessionInfo> {
		const goal = this.goalManager.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		if (!goal.swarm) {
			throw new Error(`Goal "${goal.title}" does not have swarm mode enabled`);
		}
		if (this.swarms.has(goalId)) {
			throw new Error(`Swarm already active for goal: ${goalId}`);
		}

		// Use the goal's worktree/cwd for the team lead
		const cwd = goal.worktreePath || goal.cwd;

		// Build the Team Lead role prompt with structural placeholders only
		// Secrets (gateway URL, auth token, goal ID) are passed as env vars, NOT embedded in prompt text
		const teamLeadPrompt = (getRolePrompt("team-lead") ?? "")
			.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
			.replace(/\{\{AGENT_ID\}\}/g, `team-lead-${goalId.slice(0, 8)}`);

		// Create the team lead session under the goal, with role prompt appended to goal spec
		const session = await this.sessionManager.createSession(cwd, undefined, goalId, false, {
			rolePrompt: teamLeadPrompt,
			env: {
				BOBBIT_GATEWAY_URL: this.config.gatewayUrl,
				BOBBIT_AUTH_TOKEN: this.config.authToken,
				BOBBIT_GOAL_ID: goalId,
			},
		});

		// Assign a unique color and title
		this.assignUniqueColor(session.id);
		const teamLeadName = await generateSwarmName("team-lead");
		this.sessionManager.setTitle(session.id, `Team Lead: ${teamLeadName}`);
		session.titleGenerated = true;
		this.sessionManager.updateSessionMeta(session.id, {
			role: "team-lead",
			swarmGoalId: goalId,
			worktreePath: goal.worktreePath,
		});

		// Initialize swarm tracking
		const entry: SwarmEntry = {
			goalId,
			teamLeadSessionId: session.id,
			agents: [],
			maxConcurrent: 5,
		};
		this.swarms.set(goalId, entry);
		this.sessionToGoal.set(session.id, goalId);
		this.persistEntry(goalId);

		// Transition goal to in-progress if needed
		if (goal.state === "todo") {
			this.goalManager.updateGoal(goalId, { state: "in-progress" });
		}

		// Kick off the team lead with an initial prompt (same pattern as delegate sessions)
		session.rpcClient.prompt("Execute the task described in your system prompt. Follow the instructions carefully.").catch((err: any) => {
			console.error("[swarm-manager] Failed to send team lead kickoff prompt:", err);
		});

		console.log(`[swarm-manager] Started swarm for goal "${goal.title}" — team lead: ${session.id}`);
		return session;
	}

	/**
	 * Spawn a role agent for a swarm goal.
	 * Creates an isolated git worktree and a session with the role's system prompt.
	 * Sends the task as the first prompt.
	 */
	async spawnRole(
		goalId: string,
		role: string,
		task: string,
	): Promise<{ sessionId: string; worktreePath: string }> {
		// Validate role
		if (!VALID_ROLES.includes(role)) {
			throw new Error(`Invalid role "${role}". Valid roles: ${VALID_ROLES.join(", ")}`);
		}

		if (role === 'team-lead') {
			throw new Error('Cannot spawn team-lead role via spawnRole — use startSwarm() instead');
		}

		const entry = this.swarms.get(goalId);
		if (!entry) {
			throw new Error(`No active swarm for goal: ${goalId}`);
		}

		// Check concurrency limit
		if (entry.agents.length >= entry.maxConcurrent) {
			throw new Error(
				`Swarm for goal ${goalId} already has ${entry.agents.length} agents (max: ${entry.maxConcurrent})`,
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
			// Build role system prompt
			const agentId = `${role}-${shortId}`;
			const rolePrompt = (getRolePrompt(role) ?? "")
				.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
				.replace(/\{\{AGENT_ID\}\}/g, agentId);

			// Create the session with the role's worktree as cwd, role prompt appended to goal spec
			const session = await this.sessionManager.createSession(
				worktreeResult.worktreePath,
				undefined,
				goalId,
				false,
				{
					rolePrompt,
					env: {
						BOBBIT_GATEWAY_URL: this.config.gatewayUrl,
						BOBBIT_AUTH_TOKEN: this.config.authToken,
						BOBBIT_GOAL_ID: goalId,
					},
				},
			);

			// Assign a unique color and title
			this.assignUniqueColor(session.id);
			const roleName = await generateSwarmName(role);
			const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
			this.sessionManager.setTitle(session.id, `${roleLabel}: ${roleName}`);
			session.titleGenerated = true;
			this.sessionManager.updateSessionMeta(session.id, {
				role,
				swarmGoalId: goalId,
				worktreePath: worktreeResult.worktreePath,
			});

			// Track the agent
			const agent: SwarmAgent = {
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
				console.error('[swarm-manager] Failed to send task prompt:', err);
			});

			// Subscribe to worker events to steer the team lead when the worker goes idle
			session.rpcClient.onEvent((event: any) => {
				if (event.type !== "agent_end") return;
				this.notifyTeamLead(goalId, session.id, role, agentId).catch((err) => {
					console.error("[swarm-manager] Failed to notify team lead:", err);
				});
			});

			console.log(
				`[swarm-manager] Spawned ${role} agent (${session.id}) for goal "${goal.title}" — worktree: ${worktreeResult.worktreePath}`,
			);

			return { sessionId: session.id, worktreePath: worktreeResult.worktreePath };
		} catch (err) {
			// Clean up the orphaned worktree on failure
			try {
				cleanupWorktree(goal.repoPath, worktreeResult.worktreePath, branchName, true);
				console.log(`[swarm-manager] Cleaned up orphaned worktree after spawnRole failure: ${worktreeResult.worktreePath}`);
			} catch (cleanupErr) {
				console.error(`[swarm-manager] Failed to clean up orphaned worktree ${worktreeResult.worktreePath}:`, cleanupErr);
			}
			throw err;
		}
	}

	/**
	 * Notify the team lead that a worker agent has gone idle.
	 * Sends a steer message with task context so the team lead can decide next steps.
	 */
	private async notifyTeamLead(goalId: string, workerSessionId: string, role: string, agentId: string): Promise<void> {
		const entry = this.swarms.get(goalId);
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
			await teamLeadSession.rpcClient.steer(message);
			console.log(`[swarm-manager] Steered team lead for goal ${goalId}: ${message}`);
		} catch (err) {
			console.error(`[swarm-manager] Failed to steer team lead for goal ${goalId}:`, err);
		}
	}

	/**
	 * Dismiss (terminate) a role agent session and clean up its worktree.
	 */
	async dismissRole(sessionId: string): Promise<boolean> {
		const goalId = this.sessionToGoal.get(sessionId);
		if (!goalId) {
			return false;
		}

		const entry = this.swarms.get(goalId);
		if (!entry) {
			return false;
		}

		// Don't allow dismissing the team lead via this method
		if (entry.teamLeadSessionId === sessionId) {
			throw new Error("Cannot dismiss the team lead — use completeSwarm() instead");
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
				console.log(`[swarm-manager] Cleaned up worktree for ${agent.role} agent: ${agent.worktreePath}`);
			} catch (err) {
				console.error(`[swarm-manager] Failed to clean up worktree for ${agent.role} agent:`, err);
			}
		}

		// Remove from tracking
		entry.agents.splice(agentIndex, 1);
		this.sessionToGoal.delete(sessionId);
		this.persistEntry(goalId);

		console.log(`[swarm-manager] Dismissed ${agent.role} agent (${sessionId}) for goal ${goalId}`);
		return true;
	}

	/**
	 * List all active agents for a goal.
	 */
	listAgents(goalId: string): SwarmAgentInfo[] {
		const entry = this.swarms.get(goalId);
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
	 * Complete a swarm: dismiss all role agents but keep the team lead alive.
	 * The team lead remains active to present a report and await further instructions.
	 */
	async completeSwarm(goalId: string): Promise<void> {
		const entry = this.swarms.get(goalId);
		if (!entry) {
			throw new Error(`No active swarm for goal: ${goalId}`);
		}

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[swarm-manager] Error dismissing agent ${sessionId} during swarm completion:`, err);
			}
		}

		// Keep the team lead session alive — do NOT terminate it.
		// The team lead will present a report and await further instructions.

		// Update goal state
		this.goalManager.updateGoal(goalId, { state: "complete" });

		// Keep swarm tracking alive so the team lead can still be found
		// but persist the updated state (agents cleared)
		this.persistEntry(goalId);

		console.log(`[swarm-manager] Completed swarm for goal ${goalId} — team lead remains active: ${entry.teamLeadSessionId}`);
	}

	/**
	 * Fully tear down a swarm: dismiss all agents AND terminate the team lead.
	 * Use this when explicitly shutting down everything.
	 */
	async teardownSwarm(goalId: string): Promise<void> {
		const entry = this.swarms.get(goalId);
		if (!entry) {
			throw new Error(`No active swarm for goal: ${goalId}`);
		}

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[swarm-manager] Error dismissing agent ${sessionId} during swarm teardown:`, err);
			}
		}

		// Terminate the team lead session
		if (entry.teamLeadSessionId) {
			try {
				await this.sessionManager.terminateSession(entry.teamLeadSessionId);
			} catch (err) {
				console.error(`[swarm-manager] Error terminating team lead ${entry.teamLeadSessionId}:`, err);
			}
			this.sessionToGoal.delete(entry.teamLeadSessionId);
		}

		// Remove swarm tracking entirely
		this.swarms.delete(goalId);
		this.store.remove(goalId);

		console.log(`[swarm-manager] Tore down swarm for goal ${goalId}`);
	}

	/**
	 * Get the full swarm state for a goal.
	 */
	getSwarmState(goalId: string): SwarmState | undefined {
		const entry = this.swarms.get(goalId);
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
