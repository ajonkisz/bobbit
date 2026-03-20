import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import type { ServerMessage, QueuedMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
import { GOAL_ASSISTANT_PROMPT } from "./goal-assistant.js";
import { ROLE_ASSISTANT_PROMPT } from "./role-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt } from "./system-prompt.js";
import { generateSessionTitle } from "./title-generator.js";
import { CostTracker } from "./cost-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Goal tools extension — task + artifact management for any goal session. */
const GOAL_TOOLS_EXTENSION_PATH = path.resolve(__dirname, "../../../extensions/goal-tools.ts");

export type SessionStatus = "starting" | "idle" | "streaming" | "terminated";

export interface SessionInfo {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	createdAt: number;
	lastActivity: number;
	clients: Set<WebSocket>;
	rpcClient: RpcBridge;
	eventBuffer: EventBuffer;
	unsubscribe: () => void;
	isCompacting: boolean;
	titleGenerated: boolean;
	goalId?: string;
	/** True if this is a goal-creation assistant session */
	goalAssistant?: boolean;
	/** True if this is a role-creation assistant session */
	roleAssistant?: boolean;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester', 'team-lead') */
	role?: string;
	/** The team goal ID this agent belongs to */
	teamGoalId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Task ID this session is working on */
	taskId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Allowed tools for this session (empty array = all tools allowed) */
	allowedTools?: string[];
	/** Server-side prompt queue */
	promptQueue: PromptQueue;
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Whether tool calls were executed during the current/last turn */
	turnHadToolCalls?: boolean;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

export interface SessionManagerOptions {
	/** Override the path to pi-coding-agent cli.js */
	agentCliPath?: string;
	/** Path to a custom system prompt file */
	systemPromptPath?: string;
}

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	private store = new SessionStore();
	private costTracker = new CostTracker();
	goalManager: GoalManager;
	taskManager: TaskManager;

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
		this.goalManager = new GoalManager();
		this.taskManager = new TaskManager();
	}

	getCostTracker(): CostTracker {
		return this.costTracker;
	}

	// ── Prompt queue helpers ──────────────────────────────────────────

	/** Broadcast queue state to all clients and persist. */
	broadcastQueueUpdate(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) this.broadcastQueue(session);
	}

	private broadcastQueue(session: SessionInfo): void {
		broadcast(session.clients, {
			type: "queue_update",
			sessionId: session.id,
			queue: session.promptQueue.toArray(),
		});
		this.store.update(session.id, { messageQueue: session.promptQueue.toArray() });
	}

	/**
	 * Enqueue a prompt (or follow_up). If the agent is idle and queue was empty,
	 * dispatch immediately. Otherwise add to queue and broadcast.
	 * If the agent is idle but queue has items, enqueue and drain.
	 */
	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isFollowUp?: boolean;
		isSteered?: boolean;
	}): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		// If agent is idle and queue is empty, dispatch directly
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			session.lastPromptText = text;
			session.lastPromptImages = opts?.images;
			if (opts?.isFollowUp) {
				await session.rpcClient.followUp(text);
			} else {
				await session.rpcClient.prompt(text, opts?.images);
			}
			return;
		}

		// Agent is busy or queue has items — enqueue
		session.promptQueue.enqueue(text, {
			images: opts?.images,
			attachments: opts?.attachments,
			isSteered: opts?.isSteered,
		});
		this.broadcastQueue(session);

		// If agent is idle, start draining the queue (bug fix: idle + non-empty queue)
		if (session.status === "idle") {
			this.drainQueue(session);
		}
	}

	/**
	 * Promote a queued message to steered and reorder.
	 * If the agent is streaming, immediately dequeue and dispatch the steered
	 * message via `steer` RPC so it interrupts between tool calls.
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		// If agent is streaming, dispatch the steered message immediately
		// so it gets picked up between tool calls via getSteeringMessages().
		// Keep the message in the queue (marked dispatched) so the UI shows
		// "Sent" until the turn ends and the message appears in chat.
		if (session.status === "streaming") {
			const front = session.promptQueue.peek();
			if (front?.isSteered && !front.dispatched) {
				session.promptQueue.markDispatched(front.id);
				session.rpcClient.steer(front.text).catch((err: any) => {
					console.error(`[session-manager] Failed to dispatch steered message for ${session.id}:`, err);
				});
			}
		}

		this.broadcastQueue(session);
		return true;
	}

	/** Remove a queued message. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.remove(messageId);
		if (ok) this.broadcastQueue(session);
		return ok;
	}

	/**
	 * Called when the agent becomes idle (agent_end) or when a new message is
	 * enqueued while idle. Dequeue and dispatch the next message if any exist.
	 *
	 * Always dispatches via `prompt` RPC (not `steer`) because the agent is
	 * idle at this point — `steer` is only meaningful mid-turn.
	 *
	 * Sets status to "streaming" optimistically to prevent a race where another
	 * enqueuePrompt call sees idle+empty and dispatches a second concurrent prompt.
	 */
	private drainQueue(session: SessionInfo): void {
		if (session.promptQueue.isEmpty) return;

		// Skip already-dispatched messages (steered mid-turn), then pop the next
		const next = session.promptQueue.dequeueUndispatched();
		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt
		this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;

		// Optimistic status update to prevent double-dispatch race
		session.status = "streaming";
		broadcast(session.clients, { type: "session_status", status: "streaming" });

		// Always dispatch as prompt — agent is idle, steer is only for mid-turn
		session.rpcClient.prompt(next.text, next.images).catch((err: any) => {
			console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}:`, err);
			// Revert optimistic status on failure
			session.status = "idle";
			broadcast(session.clients, { type: "session_status", status: "idle" });
		});
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		// Track tool execution during this turn
		if (event.type === "tool_execution_start") {
			session.turnHadToolCalls = true;

			// Enforce allowedTools — warn when a disallowed tool is used (case-insensitive)
			if (session.allowedTools && session.allowedTools.length > 0 && event.toolName) {
				const toolLower = event.toolName.toLowerCase();
				if (!session.allowedTools.some((t: string) => t.toLowerCase() === toolLower)) {
					console.warn(
						`[session-manager] Session ${session.id} used disallowed tool "${event.toolName}". ` +
						`Allowed: [${session.allowedTools.join(", ")}]`
					);
				}
			}
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			session.lastTurnErrored = event.message.stopReason === "error";
		}

		// When a steered user message appears in chat, remove the dispatched pill
		if (event.type === "message_end" && event.message?.role === "user") {
			if (session.promptQueue.removeDispatched()) {
				this.broadcastQueue(session);
			}
		}

		if (event.type === "agent_start") {
			session.status = "streaming";
			session.lastTurnErrored = false;
			session.turnHadToolCalls = false;
			this.store.update(session.id, { wasStreaming: true });
			broadcast(session.clients, { type: "session_status", status: "streaming" });
		} else if (event.type === "agent_end") {
			session.status = "idle";
			this.store.update(session.id, { wasStreaming: false });
			broadcast(session.clients, { type: "session_status", status: "idle" });
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				this.drainQueue(session);
			}
		} else if (event.type === "auto_compaction_start") {
			session.isCompacting = true;
		} else if (event.type === "auto_compaction_end") {
			session.isCompacting = false;
			if (!event.aborted) this.refreshAfterCompaction(session);
		}
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const hadToolCalls = session.turnHadToolCalls;
		session.lastTurnErrored = false;
		session.turnHadToolCalls = false;

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			);
		} else if (session.lastPromptText) {
			// Fresh response error — re-send the original prompt
			await session.rpcClient.prompt(session.lastPromptText, session.lastPromptImages);
		} else {
			// Fallback (e.g. session predates error tracking) — use prompt, not followUp,
			// because followUp may not be accepted when the agent is idle.
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]"
			);
		}
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	private trackCostFromEvent(session: SessionInfo, event: any): void {
		// message_update events contain usage data with cost
		if (event.type !== "message_update") return;
		const usage = event.message?.usage ?? event.usage;
		if (!usage || typeof usage.cost !== "number") return;

		const cumulativeCost = this.costTracker.recordUsage(session.id, usage);

		// Look up taskId from assigned tasks for this session
		const assignedTasks = this.taskManager.getTasksForSession(session.id);
		const taskId = assignedTasks.length > 0 ? assignedTasks[0].id : undefined;

		broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId,
			cost: cumulativeCost,
		});
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		const persisted = this.store.getAll();
		if (persisted.length === 0) return;

		// Separate regular sessions from delegate sessions
		const regular = persisted.filter(ps => !ps.delegateOf);
		const delegates = persisted.filter(ps => !!ps.delegateOf);

		console.log(`[session-manager] Restoring ${regular.length} session(s), deferring ${delegates.length} delegate(s)...`);

		// Restore regular sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < regular.length; i += CONCURRENCY) {
			const batch = regular.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
		}

		// Delegate sessions: dormant entries only — restored on-demand via addClient()
		for (const ps of delegates) {
			if (!fs.existsSync(ps.agentSessionFile)) {
				this.store.remove(ps.id);
				continue;
			}
			this.addDormantSession(ps);
		}
	}

	private async restoreOneSession(ps: PersistedSession): Promise<void> {
		if (!fs.existsSync(ps.agentSessionFile)) {
			console.log(`[session-manager] Removing ${ps.id} — agent session file missing: ${ps.agentSessionFile}`);
			this.store.remove(ps.id);
			return;
		}
		try {
			await this.restoreSession(ps);
			console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
		} catch (err) {
			console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);
			this.addDormantSession(ps);
		}
	}

	private addDormantSession(ps: PersistedSession): void {
		this.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient: new RpcBridge({ cwd: ps.cwd }), // placeholder, not started
			eventBuffer: new EventBuffer(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			goalId: ps.goalId,
			delegateOf: ps.delegateOf,
			promptQueue: new PromptQueue(ps.messageQueue),
		});
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		if (ps.goalAssistant) {
			// Goal assistant sessions get the special goal assistant prompt
			const promptPath = assembleSystemPrompt(ps.id, {
				baseSystemPromptPath: undefined,
				cwd: ps.cwd,
				goalSpec: GOAL_ASSISTANT_PROMPT,
				goalTitle: "Goal Creation Assistant",
				goalState: "active",
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.goalManager.getGoal(ps.goalId) : undefined;
			const promptPath = assembleSystemPrompt(ps.id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: ps.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: ps.title !== "New session",
			goalId: ps.goalId,
			goalAssistant: ps.goalAssistant,
			roleAssistant: ps.roleAssistant,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			accessory: ps.accessory,
			preview: ps.preview,
			promptQueue: new PromptQueue(ps.messageQueue),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(ps.id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: ps.agentSessionFile },
			15_000,
		);
		if (!switchResp.success) {
			await rpcClient.stop();
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}

		session.status = "idle";
		this.sessions.set(ps.id, session);

		// If the agent was mid-turn when the server died, re-prompt it to continue
		if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			this.store.update(ps.id, { wasStreaming: false });
			rpcClient.prompt(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, goalAssistant?: boolean, opts?: { rolePrompt?: string; env?: Record<string, string>; taskId?: string; roleAssistant?: boolean; allowedTools?: string[] }): Promise<SessionInfo> {
		const id = randomUUID();

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: agentArgs ? [...agentArgs] : [],
			env: { BOBBIT_SESSION_ID: id, ...opts?.env },
		};
		if (this.agentCliPath) {
			bridgeOptions.cliPath = this.agentCliPath;
		}

		// Auto-load goal tools extension for any goal-associated session
		// (unless it's a goal/role assistant, or already has an extension —
		// team-lead-tools.ts imports goal-tools internally, so no double-load)
		if (goalId && !goalAssistant && !opts?.roleAssistant) {
			const alreadyHasExtension = bridgeOptions.args?.includes("--extension");
			if (!alreadyHasExtension) {
				bridgeOptions.args = bridgeOptions.args || [];
				bridgeOptions.args.push("--extension", GOAL_TOOLS_EXTENSION_PATH);
			}
			// Ensure BOBBIT_GOAL_ID is set for the extension to read
			bridgeOptions.env = { ...bridgeOptions.env, BOBBIT_GOAL_ID: goalId };
		}

		if (goalAssistant) {
			// Goal assistant sessions get a special system prompt
			const promptPath = assembleSystemPrompt(id, {
				baseSystemPromptPath: undefined,
				cwd,
				goalSpec: GOAL_ASSISTANT_PROMPT,
				goalTitle: "Goal Creation Assistant",
				goalState: "active",
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else if (opts?.roleAssistant) {
			// Role assistant sessions get a special system prompt
			const promptPath = assembleSystemPrompt(id, {
				baseSystemPromptPath: undefined,
				cwd,
				goalSpec: ROLE_ASSISTANT_PROMPT,
				goalTitle: "Role Creation Assistant",
				goalState: "active",
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			// Normal sessions: global base + AGENTS.md from cwd + goal spec
			const goal = goalId ? this.goalManager.getGoal(goalId) : undefined;
			let goalSpec = goal?.spec;
			// Append role prompt for team agents (role instructions after goal spec)
			if (opts?.rolePrompt) {
				goalSpec = (goalSpec ? goalSpec + "\n\n---\n\n" : "") + opts.rolePrompt;
			}

			// Append tool restrictions if allowedTools is specified and non-empty
			if (opts?.allowedTools && opts.allowedTools.length > 0) {
				const toolList = opts.allowedTools.join(", ");
				goalSpec = (goalSpec || "") + `\n\n---\n\n## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
			}

			// Build task context if taskId is provided
			let taskTitle: string | undefined;
			let taskType: string | undefined;
			let taskSpec: string | undefined;
			let taskDependsOn: string[] | undefined;
			if (opts?.taskId) {
				const task = this.taskManager.getTask(opts.taskId);
				if (task) {
					taskTitle = task.title;
					taskType = task.type;
					taskSpec = task.spec;
					if (task.dependsOn && task.dependsOn.length > 0) {
						taskDependsOn = task.dependsOn.map(depId => {
							const dep = this.taskManager.getTask(depId);
							return dep?.title || depId;
						});
					}
				}
			}

			const promptPath = assembleSystemPrompt(id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				taskTitle,
				taskType,
				taskSpec,
				taskDependsOn,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const now = Date.now();
		const session: SessionInfo = {
			id,
			title: goalAssistant ? "Goal Assistant" : opts?.roleAssistant ? "Role Assistant" : "New session",
			cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: (goalAssistant || opts?.roleAssistant) ? true : false,
			goalId,
			goalAssistant,
			roleAssistant: opts?.roleAssistant,
			taskId: opts?.taskId,
			allowedTools: opts?.allowedTools,
			promptQueue: new PromptQueue(),
		};

		// Auto-assign task to this session
		if (opts?.taskId) {
			try {
				this.taskManager.assignTask(opts.taskId, id);
			} catch (err) {
				console.error(`[session-manager] Failed to assign task ${opts.taskId} to session ${id}:`, err);
			}
		}

		// Subscribe to agent events — broadcast to all connected clients
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;

		await rpcClient.start();
		session.status = "idle";

		this.sessions.set(id, session);

		// Capture the agent's session file path and persist
		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist session ${id}:`, err);
		});

		return session;
	}

	/**
	 * Create a delegate session — a real session that runs a task on behalf of a parent session.
	 * The delegate gets a system prompt built from AGENTS.md + instructions.
	 * After creation, the instructions are automatically sent as the first prompt.
	 * Returns the session info immediately (the prompt runs asynchronously).
	 */
	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();

		// Build the task spec: instructions + optional context
		let taskSpec = opts.instructions;
		if (opts.context && Object.keys(opts.context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(opts.context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}

		// assembleSystemPrompt handles AGENTS.md from cwd automatically
		const promptPath = assembleSystemPrompt(id, {
			baseSystemPromptPath: undefined, // No global prompt — delegate gets AGENTS.md only
			cwd: opts.cwd,
			goalSpec: taskSpec,
			goalTitle: "Delegate Task",
			goalState: "active",
		});

		const bridgeOptions: RpcBridgeOptions = { cwd: opts.cwd, env: { BOBBIT_SESSION_ID: id, BOBBIT_DELEGATE_OF: parentSessionId } };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";
		const session: SessionInfo = {
			id,
			title: `⚡ ${titleSummary}`,
			cwd: opts.cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			delegateOf: parentSessionId,
			promptQueue: new PromptQueue(),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;
		await rpcClient.start();
		session.status = "idle";
		this.sessions.set(id, session);

		// Persist session metadata
		this.persistSessionMetadata(session).then(() => {
			this.store.update(id, { delegateOf: parentSessionId });
		}).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		});

		// Send the task prompt and wait for the agent to start streaming
		// so that waitForIdle() doesn't return immediately.
		await rpcClient.prompt(
			"Execute the task described in your system prompt. Follow the instructions carefully."
		);

		// Wait for agent_start event (so session.status becomes "streaming")
		await new Promise<void>((resolve) => {
			if (session.status === "streaming") { resolve(); return; }
			const timeout = setTimeout(() => { unsub2(); resolve(); }, 10_000);
			const unsub2 = rpcClient.onEvent((event: any) => {
				if (event.type === "agent_start") {
					clearTimeout(timeout);
					unsub2();
					resolve();
				}
			});
		});

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
	}

	/**
	 * Wait for a session to become idle (not streaming).
	 * Returns immediately if already idle.
	 * Rejects on timeout.
	 */
	waitForIdle(sessionId: string, timeoutMs = 600_000): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error("Session not found"));
		if (session.status === "idle") return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve();
				}
			});
		});
	}

	/**
	 * Get the final assistant output from a session's messages.
	 */
	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session) return "";

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return "";

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		// Collect text from all assistant messages
		const texts: string[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					texts.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) texts.push(block.text);
					}
				}
			}
		}
		return texts.join("\n\n");
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				broadcast(session.clients, { type: "messages", data: msgs.data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: st.data });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const stateResp = await session.rpcClient.getState();
		if (!stateResp.success || !stateResp.data?.sessionFile) {
			console.warn(`[session-manager] Could not get agent session file for ${session.id}`);
			return;
		}

		this.store.put({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			agentSessionFile: stateResp.data.sessionFile,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			goalId: session.goalId,
			goalAssistant: session.goalAssistant,
			roleAssistant: session.roleAssistant,
			role: session.role,
			teamGoalId: session.teamGoalId,
			worktreePath: session.worktreePath,
			taskId: session.taskId,
			accessory: session.accessory,
			preview: session.preview,
		});
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		goalAssistant?: boolean;
		delegateOf?: string;
		role?: string;
		teamGoalId?: string;
		worktreePath?: string;
		taskId?: string;
		accessory?: string;
		preview?: boolean;
	}> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: s.status,
			createdAt: s.createdAt,
			lastActivity: s.lastActivity,
			clientCount: s.clients.size,
			isCompacting: s.isCompacting,
			goalId: s.goalId,
			goalAssistant: s.goalAssistant,
			roleAssistant: s.roleAssistant,
			delegateOf: s.delegateOf,
			role: s.role,
			teamGoalId: s.teamGoalId,
			worktreePath: s.worktreePath,
			taskId: s.taskId,
			accessory: s.accessory,
			preview: s.preview,
		}));
	}

	/**
	 * Get all session IDs for a goal, including terminated sessions from the store.
	 * Useful for cost aggregation where terminated sessions still have cost data.
	 */
	getAllSessionIdsForGoal(goalId: string): string[] {
		const ids = new Set(
			Array.from(this.sessions.values())
				.filter((s) => s.goalId === goalId)
				.map((s) => s.id),
		);
		for (const ps of this.store.getAll()) {
			if (ps.goalId === goalId) ids.add(ps.id);
		}
		return [...ids];
	}

	setTitle(id: string, title: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.title = title;
		this.store.update(id, { title });
		broadcast(session.clients, { type: "session_title", sessionId: id, title });
		return true;
	}

	/** Update session metadata fields (role, teamGoalId, worktreePath, accessory) and persist. */
	updateSessionMeta(id: string, updates: { role?: string; teamGoalId?: string; worktreePath?: string; accessory?: string }): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (updates.role !== undefined) session.role = updates.role;
		if (updates.teamGoalId !== undefined) session.teamGoalId = updates.teamGoalId;
		if (updates.worktreePath !== undefined) session.worktreePath = updates.worktreePath;
		if (updates.accessory !== undefined) session.accessory = updates.accessory;
		this.store.update(id, updates);
		return true;
	}

	/**
	 * Assign a role to an existing session by killing the agent, reassembling
	 * the system prompt with the role instructions, and respawning with
	 * `switch_session` to preserve conversation history.
	 */
	async assignRole(id: string, role: { name: string; promptTemplate: string; allowedTools: string[]; accessory: string }): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot assign role while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with role instructions appended
		const goal = session.goalId ? this.goalManager.getGoal(session.goalId) : undefined;
		let goalSpec = goal?.spec;
		goalSpec = (goalSpec ? goalSpec + "\n\n---\n\n" : "") + role.promptTemplate;
		if (role.allowedTools.length > 0) {
			const toolList = role.allowedTools.join(", ");
			goalSpec += `\n\n---\n\n## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
		}

		const promptPath = assembleSystemPrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };

		const rpcClient = new RpcBridge(bridgeOptions);
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			session.eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		await rpcClient.start();

		// Restore conversation from session file
		if (agentSessionFile && fs.existsSync(agentSessionFile)) {
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: agentSessionFile },
				15_000,
			);
			if (!switchResp.success) {
				console.error(`[session-manager] switch_session failed after role assignment: ${switchResp.error}`);
			}
		}

		// Swap in the new bridge and update metadata
		session.rpcClient = rpcClient;
		session.unsubscribe = unsub;
		session.status = "idle";
		session.role = role.name;
		session.accessory = role.accessory;
		session.allowedTools = role.allowedTools.length > 0 ? role.allowedTools : undefined;

		this.store.update(id, { role: role.name, accessory: role.accessory });

		broadcast(session.clients, { type: "session_status", status: "idle" } as any);

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) broadcast(session.clients, { type: "messages", data: msgs.data });
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Assigned role "${role.name}" to session ${id}`);
		return true;
	}

	/**
	 * Generate a title for a session on the first user prompt.
	 * Called immediately when the user sends a message, not after the agent replies.
	 */
	tryGenerateTitleFromPrompt(sessionId: string, userText: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.titleGenerated) return;
		session.titleGenerated = true;

		// Fire-and-forget
		this.autoGenerateTitleFromText(session, userText).catch((err) => {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		});
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const title = await generateSessionTitle(messages);
		if (title) {
			session.title = title;
			this.store.update(session.id, { title });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
		}
	}

	async autoGenerateTitle(session: SessionInfo): Promise<void> {
		try {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp.success) return;

			const messages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(messages) || messages.length === 0) return;

			const title = await generateSessionTitle(messages);
			if (title) {
				session.title = title;
				this.store.update(session.id, { title });
				broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
			}
		} catch (err) {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		}
	}

	async terminateSession(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;

		// Cascade: terminate all delegate (child) sessions first
		const children = [...this.sessions.values()].filter(s => s.delegateOf === id);
		for (const child of children) {
			console.log(`[session ${id}] Cascading terminate to delegate ${child.id}`);
			await this.terminateSession(child.id);
		}
		// Also clean up persisted-but-not-in-memory delegate sessions
		for (const ps of this.store.getAll()) {
			if (ps.delegateOf === id && !this.sessions.has(ps.id)) {
				this.store.remove(ps.id);
				cleanupSessionPrompt(ps.id);
			}
		}

		session.unsubscribe();
		await session.rpcClient.stop();
		session.status = "terminated";

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();

		this.sessions.delete(id);
		this.store.remove(id);
		cleanupSessionPrompt(id);
		return true;
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it
		if (session.status === "terminated") {
			const ps = this.store.get(sessionId);
			if (ps && fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this.restoreSession(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the new one
						const revived = this.sessions.get(sessionId);
						if (revived) revived.clients.add(ws);
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);

		// Note: tool_execution_update events from the heartbeat will flow to
		// this client naturally via the broadcast in the event listener.
		// The message-list renders partial results from toolPartialResults,
		// so no event replay is needed — the next heartbeat (every 3s) will
		// populate the state.

		return true;
	}

	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.clients.delete(ws);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// If not streaming, nothing to abort
		if (session.status !== "streaming") return;

		// Try graceful abort first
		try {
			await session.rpcClient.abort();
		} catch {
			// Abort RPC itself may fail/timeout — proceed to force kill
		}

		// Wait for the agent to become idle
		const settled = await new Promise<boolean>((resolve) => {
			if (session.status !== "streaming") {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				unsub();
				resolve(false);
			}, gracePeriodMs);
			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve(true);
				}
			});
		});

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) {
				agentSessionFile = stateResp.data?.sessionFile;
			}
		} catch {
			// Process may be unresponsive — try the persisted store
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Emit agent_end so clients know streaming stopped
		session.status = "idle";
		broadcast(session.clients, { type: "event", data: { type: "agent_end", messages: [] } });
		broadcast(session.clients, { type: "session_status", status: "idle" });

		// Restart the agent process
		try {
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;

			const rpcClient = new RpcBridge(bridgeOptions);
			const unsub = rpcClient.onEvent((event: any) => {
				session.lastActivity = Date.now();
				this.store.update(id, { lastActivity: session.lastActivity });

				this.handleAgentLifecycle(session, event);

				session.eventBuffer.push(event);
				broadcast(session.clients, { type: "event", data: event });
				this.trackCostFromEvent(session, event);
			});

			await rpcClient.start();

			// Resume session if we have the session file
			if (agentSessionFile && fs.existsSync(agentSessionFile)) {
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: agentSessionFile },
					15_000,
				);
				if (!switchResp.success) {
					console.error(`[session-manager] switch_session failed after force abort: ${switchResp.error}`);
				}
			}

			// Swap in the new bridge
			session.rpcClient = rpcClient;
			session.unsubscribe = unsub;
			session.status = "idle";
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			session.status = "terminated";
			broadcast(session.clients, { type: "session_status", status: "terminated" });
		}
	}

	async shutdown(): Promise<void> {
		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the streaming state for each session so interrupted agents
		// can be re-prompted on the next startup.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			// Snapshot the current streaming state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending agent_end that hasn't flushed to disk yet.
			this.store.update(id, { wasStreaming: session.status === "streaming" });

			session.unsubscribe();
			await session.rpcClient.stop();
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this.sessions.delete(id);
		}
	}
}
