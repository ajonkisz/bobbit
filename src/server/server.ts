import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { oauthComplete, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { listWorkflows, getWorkflow, readArtifact, listArtifactFiles, WorkflowRunner, exportDefinitions, generateReport } from "./workflows/index.js";
import { SwarmManager } from "./agent/swarm-manager.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import type { TaskType, TaskState } from "./agent/task-store.js";

const VALID_TASK_TYPES = new Set<string>(["architecture", "design-review", "mock-generation", "tdd-tests", "implementation", "code-review", "security-review", "documentation", "testing", "bug-fix", "refactor", "custom"]);
const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

export interface TlsConfig {
	cert: string;  // path to PEM certificate
	key: string;   // path to PEM private key
}

export interface GatewayConfig {
	host: string;
	port: number;
	authToken: string;
	defaultCwd: string;
	staticDir?: string;
	agentCliPath?: string;
	systemPromptPath?: string;
	tls?: TlsConfig;
}

export function createGateway(config: GatewayConfig) {
	// Export workflow definitions so agent-side extensions can discover them
	exportDefinitions();

	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
	});
	const protocol = config.tls ? "https" : "http";
	const gatewayUrl = `${protocol}://${config.host}:${config.port}`;

	// Write gateway URL to disk so agents can discover it without env vars
	const piDir = path.join(os.homedir(), ".pi");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "gateway-url"), gatewayUrl, "utf-8");

	const colorStore = new ColorStore();
	const roleStore = new RoleStore();
	const roleManager = new RoleManager(roleStore);
	const swarmManager = new SwarmManager(sessionManager, {
		colorStore,
		taskManager: sessionManager.taskManager,
	});
	const rateLimiter = new RateLimiter();
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// API routes
		if (url.pathname.startsWith("/api/")) {
			// When serving the UI (same-origin), reflect the request origin; otherwise allow any
			const corsOrigin = config.staticDir ? (req.headers.origin || "*") : "*";
			res.setHeader("Access-Control-Allow-Origin", corsOrigin);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// Auth check
			const authHeader = req.headers.authorization;
			const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
				: url.searchParams.get("token"); // Allow token in query param for links opened in new tabs
			const ip = req.socket.remoteAddress || "unknown";

			if (rateLimiter.isRateLimited(ip)) {
				res.writeHead(429);
				res.end();
				return;
			}

			if (!token || !validateToken(token, config.authToken)) {
				if (token) rateLimiter.recordFailure(ip);
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Unauthorized" }));
				return;
			}

			await handleApiRoute(url, req, res, sessionManager, config, colorStore, swarmManager, roleManager);
			return;
		}

		// Static file serving
		if (config.staticDir) {
			serveStatic(url.pathname, config.staticDir, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	};

	const server: http.Server | https.Server = config.tls
		? https.createServer(
			{
				cert: fs.readFileSync(config.tls.cert),
				key: fs.readFileSync(config.tls.key),
			},
			requestHandler,
		)
		: http.createServer(requestHandler);

	// WebSocket server (noServer mode — we handle upgrade manually)
	const wss = new WebSocketServer({ noServer: true });

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const match = url.pathname.match(/^\/ws\/([^/]+)$/);

		if (!match) {
			socket.destroy();
			return;
		}

		const ip = req.socket.remoteAddress || "unknown";
		if (rateLimiter.isRateLimited(ip)) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			handleWebSocketConnection(ws, match[1], req, sessionManager, config.authToken, rateLimiter);
		});
	});

	return {
		server,
		sessionManager,
		async start() {
			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();
			return new Promise<void>((resolve) => {
				server.listen(config.port, config.host, () => resolve());
			});
		},
		async shutdown() {
			clearInterval(cleanupInterval);
			wss.close();
			await sessionManager.shutdown();
			server.close();
		},
	};
}

async function handleApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sessionManager: SessionManager,
	config: GatewayConfig,
	colorStore: ColorStore,
	swarmManager: SwarmManager,
	roleManager: RoleManager,
) {
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};

	// GET /api/health
	if (url.pathname === "/api/health" && req.method === "GET") {
		json({ status: "ok", sessions: sessionManager.listSessions().length });
		return;
	}

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
		const sessions = sessionManager.listSessions().map((s) => ({
			...s,
			colorIndex: colorStore.get(s.id),
		}));
		json({ sessions });
		return;
	}

	// GET /api/sessions/:id (exact match — not /api/sessions/:id/output etc.)
	const singleSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (singleSessionMatch && req.method === "GET") {
		const id = singleSessionMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) {
			res.writeHead(404);
			res.end(JSON.stringify({ error: "Session not found" }));
			return;
		}
		json({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			status: session.status,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			clientCount: session.clients.size,
			isCompacting: session.isCompacting,
			goalId: session.goalId,
			goalAssistant: session.goalAssistant,
			delegateOf: session.delegateOf,
			role: session.role,
			swarmGoalId: session.swarmGoalId,
			worktreePath: session.worktreePath,
			taskId: session.taskId,
			colorIndex: colorStore.get(session.id),
		});
		return;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const body = await readBody(req);

		// ── Delegate session creation ──
		if (body?.delegateOf && body?.instructions) {
			try {
				const cwd = body.cwd || config.defaultCwd;
				const session = await sessionManager.createDelegateSession(body.delegateOf, {
					instructions: body.instructions,
					cwd,
					title: body.title,
					context: body.context,
				});
				json({
					id: session.id,
					cwd: session.cwd,
					status: session.status,
					delegateOf: session.delegateOf,
				}, 201);
			} catch (err) {
				json({ error: String(err) }, 500);
			}
			return;
		}

		// ── Normal session creation ──
		const goalId = body?.goalId;
		const goalAssistant = body?.goalAssistant === true;
		const roleAssistant = body?.roleAssistant === true;

		// If creating under a goal, use the goal's cwd as default
		let cwd = body?.cwd || config.defaultCwd;
		if (goalId) {
			const goal = sessionManager.goalManager.getGoal(goalId);
			if (goal) {
				cwd = body?.cwd || goal.cwd;
				// Auto-transition goal to in-progress when first session starts
				if (goal.state === "todo") {
					sessionManager.goalManager.updateGoal(goalId, { state: "in-progress" });
				}
			}
		}

		const args = body?.args;

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, goalAssistant, roleAssistant ? { roleAssistant: true } : undefined);
			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				goalId: session.goalId,
				goalAssistant: session.goalAssistant,
				roleAssistant: session.roleAssistant,
			}, 201);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		json({ goals: sessionManager.goalManager.listGoals() });
		return;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		const cwd = body?.cwd || config.defaultCwd;
		const spec = body?.spec || "";
		const swarm = body?.swarm === true;
		const worktree = body?.worktree === true;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		const goal = sessionManager.goalManager.createGoal(title, cwd, { spec, swarm, worktree });
		json(goal, 201);
		return;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = sessionManager.goalManager.getGoal(id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = sessionManager.goalManager.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				swarm: body.swarm,
				repoPath: body.repoPath,
				branch: body.branch,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			sessionManager.taskManager.deleteTasksForGoal(id);
			sessionManager.goalManager.deleteGoal(id);
			json({ ok: true });
			return;
		}
	}

	// ── Role endpoints ─────────────────────────────────────────────

	// GET /api/tools — list available agent tools
	if (url.pathname === "/api/tools" && req.method === "GET") {
		json({ tools: roleManager.getAvailableTools() });
		return;
	}

	// GET /api/roles
	if (url.pathname === "/api/roles" && req.method === "GET") {
		json({ roles: roleManager.listRoles() });
		return;
	}

	// POST /api/roles
	if (url.pathname === "/api/roles" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const role = roleManager.createRole({
				name: body?.name,
				label: body?.label,
				promptTemplate: body?.promptTemplate || "",
				allowedTools: body?.allowedTools,
				accessory: body?.accessory,
			});
			json(role, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// Routes with role :name parameter
	const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);

		if (req.method === "GET") {
			const role = roleManager.getRole(name);
			if (!role) { json({ error: "Role not found" }, 404); return; }
			json(role);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = roleManager.updateRole(name, {
				label: body.label,
				promptTemplate: body.promptTemplate,
				allowedTools: body.allowedTools,
				accessory: body.accessory,
			});
			if (!ok) { json({ error: "Role not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			const ok = roleManager.deleteRole(name);
			if (!ok) { json({ error: "Role not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// ── Task endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/tasks — list tasks for a goal
	const goalTasksMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tasks$/);
	if (goalTasksMatch && req.method === "GET") {
		const tasks = sessionManager.taskManager.getTasksForGoal(goalTasksMatch[1]);
		json({ tasks });
		return;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }

		const body = await readBody(req);
		const title = body?.title;
		const type = body?.type;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		if (!type || typeof type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		if (!VALID_TASK_TYPES.has(type)) {
			json({ error: `Invalid task type: ${type}` }, 400);
			return;
		}
		try {
			const task = sessionManager.taskManager.createTask(goalId, title, type as TaskType, {
				parentTaskId: body.parentTaskId,
				spec: body.spec,
				dependsOn: body.dependsOn,
			});
			json(task, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// Routes with task :id parameter
	const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskMatch) {
		const id = taskMatch[1];

		// GET /api/tasks/:id
		if (req.method === "GET") {
			const task = sessionManager.taskManager.getTask(id);
			if (!task) { json({ error: "Task not found" }, 404); return; }
			json(task);
			return;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const ok = sessionManager.taskManager.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
				});
				if (!ok) { json({ error: "Task not found" }, 404); return; }
				json({ ok: true });
			} catch (err: any) {
				json({ error: err.message }, 400);
			}
			return;
		}

		// DELETE /api/tasks/:id
		if (req.method === "DELETE") {
			const ok = sessionManager.taskManager.deleteTask(id);
			if (!ok) { json({ error: "Task not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// POST /api/tasks/:id/assign — assign task to session
	const taskAssignMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
	if (taskAssignMatch && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = body?.sessionId;
		if (!sessionId || typeof sessionId !== "string") {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = sessionManager.taskManager.assignTask(taskAssignMatch[1], sessionId);
			if (!ok) { json({ error: "Task not found" }, 400); return; }
			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// POST /api/tasks/:id/transition — state transition
	const taskTransitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
	if (taskTransitionMatch && req.method === "POST") {
		const body = await readBody(req);
		const state = body?.state;
		if (!state || typeof state !== "string") {
			json({ error: "Missing state" }, 400);
			return;
		}
		if (!VALID_TASK_STATES.has(state)) {
			json({ error: `Invalid task state: ${state}` }, 400);
			return;
		}
		try {
			const ok = sessionManager.taskManager.transitionTask(taskTransitionMatch[1], state as TaskState);
			if (!ok) { json({ error: "Task not found" }, 400); return; }
			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// ── Swarm endpoints ────────────────────────────────────────────

	// POST /api/goals/:id/swarm/start — start a swarm for a goal
	const swarmStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/start$/);
	if (swarmStartMatch && req.method === "POST") {
		const goalId = swarmStartMatch[1];
		try {
			const session = await swarmManager.startSwarm(goalId);
			json({ sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/swarm/spawn — spawn a role agent
	const swarmSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/spawn$/);
	if (swarmSpawnMatch && req.method === "POST") {
		const goalId = swarmSpawnMatch[1];
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json({ error: "Missing role or task" }, 400);
			return;
		}
		try {
			const result = await swarmManager.spawnRole(goalId, body.role, body.task);
			json(result, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/swarm/dismiss — dismiss a role agent
	const swarmDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/dismiss$/);
	if (swarmDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = await swarmManager.dismissRole(body.sessionId);
			json({ ok });
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const branch = goal.branch || "HEAD";
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
		try {
			const { execFileSync } = require("node:child_process");
			const out = execFileSync("git", ["log", "--format=%H|%h|%s|%an|%aI", "-20", branch], {
				cwd: goal.cwd, encoding: "utf-8",
			});
			const commits = out.trim().split("\n").filter(Boolean).map((line: string) => {
				const [sha, shortSha, message, author, timestamp] = line.split("|");
				return { sha, shortSha, message, author, timestamp };
			});
			json(commits);
		} catch (e: any) {
			json({ error: "Failed to read git log", detail: e.message }, 500);
		}
		return;
	}

	// GET /api/goals/:id/swarm — get swarm state
	const swarmStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm$/);
	if (swarmStateMatch && req.method === "GET") {
		const goalId = swarmStateMatch[1];
		const state = swarmManager.getSwarmState(goalId);
		if (!state) {
			json({ error: "No active swarm for this goal" }, 404);
			return;
		}
		json(state);
		return;
	}

	// GET /api/goals/:id/swarm/agents — list agents for a swarm goal
	const swarmAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/agents$/);
	if (swarmAgentsMatch && req.method === "GET") {
		const goalId = swarmAgentsMatch[1];
		json({ agents: swarmManager.listAgents(goalId) });
		return;
	}

	// POST /api/goals/:id/swarm/complete — complete a swarm (dismiss agents, keep team lead)
	const swarmCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/complete$/);
	if (swarmCompleteMatch && req.method === "POST") {
		const goalId = swarmCompleteMatch[1];
		try {
			await swarmManager.completeSwarm(goalId);
			json({ ok: true });
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/swarm/teardown — fully tear down a swarm (dismiss agents + terminate team lead)
	const swarmTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/swarm\/teardown$/);
	if (swarmTeardownMatch && req.method === "POST") {
		const goalId = swarmTeardownMatch[1];
		try {
			await swarmManager.teardownSwarm(goalId);
			json({ ok: true });
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// Routes with :id parameter
	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const id = sessionMatch[1];

		if (req.method === "GET") {
			const session = sessionManager.getSession(id);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				status: session.status,
				createdAt: session.createdAt,
				clientCount: session.clients.size,
			});
			return;
		}

		if (req.method === "DELETE") {
			const terminated = await sessionManager.terminateSession(id);
			if (!terminated) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({ ok: true });
			return;
		}
	}

	// POST /api/sessions/:id/wait — block until session becomes idle
	const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
	if (waitMatch && req.method === "POST") {
		const id = waitMatch[1];
		const body = await readBody(req);
		const timeoutMs = body?.timeout_ms ?? 600_000;
		try {
			await sessionManager.waitForIdle(id, timeoutMs);
			// Session is idle — return the output
			const output = await sessionManager.getSessionOutput(id);
			const session = sessionManager.getSession(id);
			json({
				status: session?.status || "idle",
				output,
			});
		} catch (err) {
			json({ error: String(err) }, 408); // Request Timeout
		}
		return;
	}

	// GET /api/sessions/:id/output — get final assistant output
	const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
	if (outputMatch && req.method === "GET") {
		const id = outputMatch[1];
		try {
			const output = await sessionManager.getSessionOutput(id);
			json({ output });
		} catch {
			json({ error: "Failed to get output" }, 500);
		}
		return;
	}

	// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
	const patchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (patchMatch && req.method === "PATCH") {
		const id = patchMatch[1];
		const body = await readBody(req);
		if (!body || typeof body !== "object") {
			json({ error: "Invalid body" }, 400);
			return;
		}

		if (typeof body.title === "string") {
			const ok = sessionManager.setTitle(id, body.title);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
		}

		if (typeof body.colorIndex === "number") {
			if (body.colorIndex < 0 || body.colorIndex > 19) {
				json({ error: "colorIndex must be 0-19" }, 400);
				return;
			}
			colorStore.set(id, body.colorIndex);
		}

		json({ ok: true });
		return;
	}

	// PUT /api/sessions/:id/title — legacy rename endpoint
	const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
	if (titleMatch && req.method === "PUT") {
		const id = titleMatch[1];
		const body = await readBody(req);
		const title = body?.title;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		const ok = sessionManager.setTitle(id, title);
		if (!ok) {
			json({ error: "Session not found" }, 404);
			return;
		}
		json({ ok: true });
		return;
	}

	// GET /api/connection-info — LAN addresses for multi-device access
	if (url.pathname === "/api/connection-info" && req.method === "GET") {
		const interfaces = await import("node:os").then((os) => os.networkInterfaces());
		const addresses: { ip: string; name: string }[] = [];
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					addresses.push({ ip: addr.address, name });
				}
			}
		}
		json({ addresses, port: config.port });
		return;
	}

	// GET /api/oauth/status
	if (url.pathname === "/api/oauth/status" && req.method === "GET") {
		json(oauthStatus());
		return;
	}

	// POST /api/oauth/start — begin OAuth flow, returns auth URL
	if (url.pathname === "/api/oauth/start" && req.method === "POST") {
		try {
			const result = await oauthStart();
			json(result);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// POST /api/oauth/complete — exchange code for tokens
	if (url.pathname === "/api/oauth/complete" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.flowId || !body?.code) {
			json({ error: "Missing flowId or code" }, 400);
			return;
		}
		try {
			const result = await oauthComplete(body.flowId, body.code);
			json(result, result.success ? 200 : 400);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// GET /api/sessions/:id/git-status — get git status for session's working directory
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const cwd = session.cwd;
		const execOpts = { cwd, encoding: 'utf-8' as const, timeout: 5000 };

		try {
			// Get branch name
			let branch = '';
			try {
				branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim();
			} catch {
				json({ error: "Not a git repository" }, 400);
				return;
			}

			// Detect primary branch (master or main)
			let primaryBranch = 'master';
			try {
				const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', execOpts).trim();
				primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
			} catch {
				// Fallback: check if master or main exists
				try {
					execSync('git rev-parse --verify refs/heads/master', execOpts);
					primaryBranch = 'master';
				} catch {
					try {
						execSync('git rev-parse --verify refs/heads/main', execOpts);
						primaryBranch = 'main';
					} catch { /* keep default */ }
				}
			}

			const isOnPrimary = branch === primaryBranch;

			// Get status
			let statusRaw = '';
			try {
				// Only trim trailing whitespace — leading spaces are significant
				// in porcelain format (they encode index vs working-tree status)
				statusRaw = execSync('git status --porcelain', execOpts).replace(/\s+$/, '');
			} catch { /* empty */ }

			const statusLines = statusRaw ? statusRaw.split('\n') : [];
			const status = statusLines.map(line => {
				// Strip trailing \r from Windows CRLF line endings
				const l = line.endsWith('\r') ? line.slice(0, -1) : line;
				return {
					file: l.substring(3),
					status: l.substring(0, 2).trim(),
				};
			});

			// Check if branch has an upstream tracking branch
			let hasUpstream = false;
			try {
				execSync(`git rev-parse --abbrev-ref ${branch}@{u}`, execOpts);
				hasUpstream = true;
			} catch { /* no upstream */ }

			// Get ahead/behind vs upstream (only if upstream exists)
			let ahead = 0;
			let behind = 0;
			if (hasUpstream) {
				try {
					ahead = parseInt(execSync('git rev-list --count @{u}..HEAD', execOpts).trim(), 10) || 0;
				} catch { /* ignore */ }
				try {
					behind = parseInt(execSync('git rev-list --count HEAD..@{u}', execOpts).trim(), 10) || 0;
				} catch { /* ignore */ }
			}

			// If on a feature branch, check relationship to primary
			let aheadOfPrimary = 0;
			let behindPrimary = 0;
			let mergedIntoPrimary = false;
			if (!isOnPrimary) {
				// Check against origin/<primary> first (more up-to-date), fall back to local
				const primaryRef = (() => {
					try {
						execSync(`git rev-parse --verify origin/${primaryBranch}`, execOpts);
						return `origin/${primaryBranch}`;
					} catch {
						return primaryBranch;
					}
				})();
				try {
					aheadOfPrimary = parseInt(execSync(`git rev-list --count ${primaryRef}..HEAD`, execOpts).trim(), 10) || 0;
				} catch { /* primary branch may not exist */ }
				try {
					behindPrimary = parseInt(execSync(`git rev-list --count HEAD..${primaryRef}`, execOpts).trim(), 10) || 0;
				} catch { /* ignore */ }
				// Branch is merged if it has no commits ahead of origin/primary
				mergedIntoPrimary = aheadOfPrimary === 0;
			}

			const clean = statusLines.length === 0;

			// Build summary
			let summary = 'clean';
			if (!clean) {
				const counts: Record<string, number> = {};
				for (const line of statusLines) {
					const code = line.substring(0, 2).trim();
					let key: string;
					if (code.includes('?')) key = '?';
					else if (code.includes('M')) key = 'M';
					else if (code.includes('A')) key = 'A';
					else if (code.includes('D')) key = 'D';
					else if (code.includes('R')) key = 'R';
					else if (code.includes('U')) key = 'U';
					else key = code;
					counts[key] = (counts[key] || 0) + 1;
				}
				summary = Object.entries(counts).map(([k, v]) => `${v}${k}`).join(' ');
			}

			json({
				branch,
				primaryBranch,
				isOnPrimary,
				status,
				hasUpstream,
				ahead,
				behind,
				aheadOfPrimary,
				behindPrimary,
				mergedIntoPrimary,
				clean,
				summary,
				unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
			});
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// GET /api/workflows — list available workflow definitions
	if (url.pathname === "/api/workflows" && req.method === "GET") {
		json({ workflows: listWorkflows().map((w) => ({ id: w.id, name: w.name, description: w.description, phaseCount: w.phases.length })) });
		return;
	}

	// GET /api/sessions/:id/workflow — get workflow state for a session
	const workflowStateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/workflow$/);
	if (workflowStateMatch && req.method === "GET") {
		const id = workflowStateMatch[1];
		const session = sessionManager.getSession(id);
		const runner = (session as any)?._workflowRunner as InstanceType<typeof WorkflowRunner> | undefined
			?? WorkflowRunner.restore(id);
		if (!runner) {
			json({ error: "No workflow for this session" }, 404);
			return;
		}
		json(runner.getState());
		return;
	}

	// The server is the single source of truth for report rendering.
	// The agent extension writes state + artifacts; the server renders the report.
	const workflowReportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/workflow\/report$/);
	if (workflowReportMatch && req.method === "GET") {
		const id = workflowReportMatch[1];

		const resolvedReportId = resolveWorkflowSessionId(id, sessionManager);

		// Try to load workflow state and regenerate the report from it
		const runner = (sessionManager.getSession(id) as any)?._workflowRunner as InstanceType<typeof WorkflowRunner> | undefined
			?? WorkflowRunner.restore(id)
			?? WorkflowRunner.restore(resolvedReportId);
		if (runner) {
			const state = runner.getState();
			const workflow = getWorkflow(state.workflowId);
			if (workflow) {
				try {
					const html = generateReport(workflow, state);
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(html);
					return;
				} catch (err) {
					console.error("[report] Failed to generate report:", err);
					json({ error: `Report generation failed: ${err instanceof Error ? err.message : String(err)}` }, 500);
					return;
				}
			}
		}

		// Fallback: serve pre-generated report if it exists on disk
		const html = readArtifact(resolvedReportId, "report.html");
		if (!html) {
			json({ error: "Report not found" }, 404);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(html);
		return;
	}

	// GET /api/sessions/:id/workflow/artifacts — list artifacts
	const artifactListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/workflow\/artifacts$/);
	if (artifactListMatch && req.method === "GET") {
		const id = artifactListMatch[1];
		const resolvedId = resolveWorkflowSessionId(id, sessionManager);
		json({ artifacts: listArtifactFiles(resolvedId) });
		return;
	}

	// GET /api/sessions/:id/workflow/artifacts/:filename — serve an artifact
	const artifactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/workflow\/artifacts\/([^/]+)$/);
	if (artifactMatch && req.method === "GET") {
		const [, id, filename] = artifactMatch;
		const resolvedId = resolveWorkflowSessionId(id, sessionManager);
		const content = readArtifact(resolvedId, decodeURIComponent(filename));
		if (!content) {
			json({ error: "Artifact not found" }, 404);
			return;
		}
		const ext = filename.split(".").pop()?.toLowerCase() || "";
		const mimeType = MIME_TYPES[`.${ext}`] || "application/octet-stream";
		res.writeHead(200, { "Content-Type": mimeType });
		res.end(content);
		return;
	}

	// ── Cost endpoints ─────────────────────────────────────────────

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const cost = sessionManager.getCostTracker().getSessionCost(id);
		if (!cost) {
			json({ error: "No cost data for this session" }, 404);
			return;
		}
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker().getGoalCost(goalId, sessionIds);
		json(cost);
		return;
	}

	// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task
	const taskCostMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cost$/);
	if (taskCostMatch && req.method === "GET") {
		const taskId = taskCostMatch[1];
		const task = sessionManager.taskManager.getTask(taskId);
		if (!task) {
			json({ error: "Task not found" }, 404);
			return;
		}
		if (!task.assignedSessionId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const cost = sessionManager.getCostTracker().getSessionCost(task.assignedSessionId);
		json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
		return;
	}

	json({ error: "Not found" }, 404);
}

/**
 * Resolve the workflow session ID used for artifact storage.
 *
 * The gateway uses UUIDs for session IDs, but the workflow extension stores
 * artifacts under the agent's session directory name (extracted from the
 * agent session file path, e.g., "--C--Users-jsubr-w-bobbit--").
 *
 * Resolution order:
 *   1. Gateway session ID directly
 *   2. Agent session directory name (from persisted session data)
 *   3. Scan all workflow-artifacts dirs for matching workflow state
 */
function resolveWorkflowSessionId(gatewaySessionId: string, sessionManager: SessionManager): string {
	// 1. Check if artifacts exist directly under the gateway session ID
	const directFiles = listArtifactFiles(gatewaySessionId);
	if (directFiles.length > 0) return gatewaySessionId;

	// 2. Extract agent session directory name from persisted session data
	const agentDirName = getAgentSessionDirName(gatewaySessionId, sessionManager);
	if (agentDirName) {
		const agentFiles = listArtifactFiles(agentDirName);
		if (agentFiles.length > 0) return agentDirName;
	}

	// 3. Scan workflow-state files for one referencing this gateway session or agent dir
	const stateDir = path.join(os.homedir(), ".pi", "workflow-state");
	try {
		for (const file of fs.readdirSync(stateDir)) {
			if (!file.endsWith(".json")) continue;
			const candidateId = file.replace(/\.json$/, "");
			const candidateFiles = listArtifactFiles(candidateId);
			if (candidateFiles.length > 0) {
				// Check if this state file's sessionId matches something we know
				if (agentDirName && candidateId === agentDirName) return candidateId;
				// Also check if the state file itself references our gateway or agent dir
				try {
					const stateData = JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf-8"));
					if (stateData.sessionId === gatewaySessionId || stateData.sessionId === agentDirName) {
						return stateData.sessionId;
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	return gatewaySessionId;
}

/** Extract the agent session directory name from persisted gateway session data */
function getAgentSessionDirName(gatewaySessionId: string, sessionManager: SessionManager): string | null {
	// Try live session first
	const session = sessionManager.getSession(gatewaySessionId);
	if (session) {
		try {
			// RPC bridge state may have the session file
			const rpc = session.rpcClient as any;
			const sf = rpc._lastSessionFile ?? rpc.sessionFile;
			if (sf) {
				const dir = extractSessionDirFromPath(sf);
				if (dir) return dir;
			}
		} catch { /* ignore */ }
	}

	// Try persisted session store
	try {
		const storeFile = path.join(os.homedir(), ".pi", "gateway-sessions.json");
		const data = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
		const sessions = Array.isArray(data) ? data : [];
		for (const s of sessions) {
			if (s.id === gatewaySessionId && s.agentSessionFile) {
				const dir = extractSessionDirFromPath(s.agentSessionFile);
				if (dir) return dir;
			}
		}
	} catch { /* ignore */ }

	return null;
}

/** Extract session directory name from a session file path like ".../sessions/dirname/file.jsonl" */
function extractSessionDirFromPath(sessionFilePath: string): string | null {
	const parts = String(sessionFilePath).replace(/\\/g, "/").split("/");
	const idx = parts.indexOf("sessions");
	if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
	return null;
}

function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve(null);
			}
		});
	});
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse) {
	const resolvedStaticDir = path.resolve(staticDir);
	let filePath = path.resolve(staticDir, pathname === "/" ? "index.html" : pathname.slice(1));

	// Prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		res.writeHead(403);
		res.end();
		return;
	}

	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			// SPA fallback — serve index.html for unmatched routes
			filePath = path.join(resolvedStaticDir, "index.html");
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const ext = path.extname(filePath).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = fs.readFileSync(filePath);

		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
	} catch {
		res.writeHead(500);
		res.end("Internal server error");
	}
}
