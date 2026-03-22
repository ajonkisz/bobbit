import { execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { piDir } from "./pi-dir.js";
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { oauthComplete, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { exportSkillDefinitions, listSkills } from "./skills/index.js";
import { TeamManager } from "./agent/team-manager.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolStore } from "./agent/tool-store.js";
import { ToolManager } from "./agent/tool-manager.js";
import { PersonalityStore } from "./agent/personality-store.js";
import { PersonalityManager } from "./agent/personality-manager.js";

import type { TaskState } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { GoalArtifactStore } from "./agent/goal-artifact-store.js";
import { WorkflowStore } from "./agent/workflow-store.js";
import { WorkflowManager } from "./agent/workflow-manager.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

export interface TlsConfig {
	cert: string;  // path to PEM certificate
	key: string;   // path to PEM private key
	caCert?: string;  // path to CA certificate (for mkcert-based certs)
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
	// Export skill definitions so agent-side extensions can discover them
	exportSkillDefinitions();

	const colorStore = new ColorStore();
	const personalityStore = new PersonalityStore();
	const personalityManager = new PersonalityManager(personalityStore);
	fs.mkdirSync(piDir(), { recursive: true });
	const roleStore = new RoleStore();
	const roleManager = new RoleManager(roleStore);
	const toolStore = new ToolStore();
	const toolManager = new ToolManager(toolStore);
	const goalArtifactStore = new GoalArtifactStore();
	const workflowStore = new WorkflowStore();
	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		personalityManager,
		roleManager,
		toolManager,
		workflowStore,
	});
	const protocol = config.tls ? "https" : "http";
	const gatewayUrl = `${protocol}://${config.host}:${config.port}`;
	const workflowManager = new WorkflowManager(workflowStore);
	const staffManager = new StaffManager();
	const triggerEngine = new TriggerEngine(staffManager, sessionManager);
	triggerEngine.start();
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: sessionManager.taskManager,
		roleStore,
		goalArtifactStore,
		personalityManager,
	});
	const bgProcessManager = new BgProcessManager((sessionId: string) => {
		const session = sessionManager.getSession(sessionId);
		return session?.clients;
	});
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	const rateLimiter = new RateLimiter();
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

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

			await handleApiRoute(url, req, res, sessionManager, config, colorStore, teamManager, roleManager, toolManager, goalArtifactStore, personalityManager, bgProcessManager, staffManager, workflowManager, verificationHarness);

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

	// Broadcast a message to WebSocket clients belonging to a specific goal
	function broadcastToGoal(goalId: string, event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				const sid = (ws as any).sessionId as string | undefined;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (session?.teamGoalId === goalId || session?.goalId === goalId) {
						ws.send(data);
						continue;
					}
				}
				// Fallback: if we can't determine goal association, still send
				// (e.g. the user's browser session viewing the goal dashboard)
				ws.send(data);
			}
		}
	}

	verificationHarness = new VerificationHarness(goalArtifactStore, broadcastToGoal);

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
			triggerEngine.stop();
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
	teamManager: TeamManager,
	roleManager: RoleManager,
	toolManager: ToolManager,
	goalArtifactStore: GoalArtifactStore,
	personalityManager: PersonalityManager,
	bgProcessManager: BgProcessManager,
	staffManager: StaffManager,
	workflowManager: WorkflowManager,
	verificationHarness: VerificationHarness,
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

	// GET /api/ca-cert — download the Bobbit CA certificate for device trust
	if (url.pathname === "/api/ca-cert" && req.method === "GET") {
		const caCertPath = config.tls?.caCert;
		if (!caCertPath || !fs.existsSync(caCertPath)) {
			json({ error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
			return;
		}
		const certData = fs.readFileSync(caCertPath);
		res.writeHead(200, {
			"Content-Type": "application/x-pem-file",
			"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
			"Content-Length": certData.length,
		});
		res.end(certData);
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
			assistantType: session.assistantType,
			// Legacy boolean fields for backward compat
			goalAssistant: session.assistantType === "goal",
			roleAssistant: session.assistantType === "role",
			toolAssistant: session.assistantType === "tool",
			delegateOf: session.delegateOf,
			role: session.role,
			teamGoalId: session.teamGoalId,
			worktreePath: session.worktreePath,
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			personalities: session.personalities,
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

		// Accept both new assistantType and legacy boolean fields
		let assistantType = body?.assistantType as string | undefined;
		if (!assistantType) {
			if (body?.goalAssistant) assistantType = "goal";
			else if (body?.roleAssistant) assistantType = "role";
			else if (body?.toolAssistant) assistantType = "tool";
		}

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

		// If a roleId is provided, look up the role and pass its prompt/tools/accessory
		const roleId = body?.roleId;
		let createOpts: { rolePrompt?: string; allowedTools?: string[]; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[] } | undefined;
		let roleForMeta: { name: string; accessory: string } | undefined;

		if (roleId && typeof roleId === "string") {
			const role = roleManager.getRole(roleId);
			if (!role) {
				json({ error: `Role "${roleId}" not found` }, 404);
				return;
			}
			createOpts = {
				rolePrompt: role.promptTemplate,
				allowedTools: role.allowedTools,
			};
			roleForMeta = { name: role.name, accessory: role.accessory };
		}

		// Resolve personalities
		const bodyPersonalities = Array.isArray(body?.personalities) ? body.personalities as string[] : undefined;
		let personalityNames: string[] | undefined;
		if (bodyPersonalities && bodyPersonalities.length > 0) {
			// Validate personality names
			const invalid = bodyPersonalities.filter(t => !personalityManager.getPersonality(t));
			if (invalid.length > 0) {
				json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return;
			}
			personalityNames = bodyPersonalities;
		} else if (roleForMeta) {
			// Use role's default personalities if no explicit personalities provided
			const role = roleManager.getRole(roleForMeta.name);
			if (role?.defaultPersonalities && role.defaultPersonalities.length > 0) {
				personalityNames = role.defaultPersonalities;
			}
		}

		if (personalityNames && personalityNames.length > 0) {
			const resolved = personalityManager.resolvePersonalities(personalityNames);
			createOpts = { ...createOpts, personalities: resolved, personalityNames };
		}

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, createOpts);

			// Set role metadata if a role was specified
			if (roleForMeta) {
				sessionManager.updateSessionMeta(session.id, { role: roleForMeta.name, accessory: roleForMeta.accessory });
				session.role = roleForMeta.name;
				session.accessory = roleForMeta.accessory;
			}

			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				goalId: session.goalId,
				assistantType: session.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: session.assistantType === "goal",
				roleAssistant: session.assistantType === "role",
				toolAssistant: session.assistantType === "tool",
				role: session.role,
				accessory: session.accessory,
				personalities: session.personalities,
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
		const team = body?.team === true || body?.swarm === true; // Accept legacy 'swarm' field
		const worktree = body?.worktree === true;
		const workflowId = body?.workflowId;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		try {
			const goal = sessionManager.goalManager.createGoal(title, cwd, {
				spec,
				team,
				worktree,
				workflowId: workflowId && typeof workflowId === "string" ? workflowId : undefined,
				workflowStore: workflowId ? workflowManager.store : undefined,
			});
			json(goal, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
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
				team: body.team ?? body.swarm, // Accept legacy 'swarm' field
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
		json({ tools: toolManager.getAvailableTools() });
		return;
	}

	// Routes with tool :name parameter
	const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
	if (toolMatch) {
		const name = decodeURIComponent(toolMatch[1]);

		if (req.method === "GET") {
			const tool = toolManager.getToolByName(name);
			if (!tool) { json({ error: "Tool not found" }, 404); return; }
			json(tool);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = toolManager.updateToolMetadata(name, {
				description: body.description,
				group: body.group,
				docs: body.docs,
			});
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
			return;
		}
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

	// ── Personality endpoints ──────────────────────────────────────

	// GET /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "GET") {
		json({ personalities: personalityManager.listPersonalities() });
		return;
	}

	// POST /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const personality = personalityManager.createPersonality({
				name: body?.name,
				label: body?.label,
				description: body?.description || "",
				promptFragment: body?.promptFragment || "",
			});
			json(personality, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// Routes with personality :name parameter
	const personalityMatch = url.pathname.match(/^\/api\/personalities\/([^/]+)$/);
	if (personalityMatch) {
		const name = decodeURIComponent(personalityMatch[1]);

		if (req.method === "GET") {
			const personality = personalityManager.getPersonality(name);
			if (!personality) { json({ error: "Personality not found" }, 404); return; }
			json(personality);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = personalityManager.updatePersonality(name, {
				label: body.label,
				description: body.description,
				promptFragment: body.promptFragment,
			});
			if (!ok) { json({ error: "Personality not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			const ok = personalityManager.deletePersonality(name);
			if (!ok) { json({ error: "Personality not found" }, 404); return; }
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
		try {
			const task = sessionManager.taskManager.createTask(goalId, title, type, {
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

	// GET /api/goals/:goalId/artifacts — list artifacts for a goal
	const goalArtifactsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/artifacts$/);
	if (goalArtifactsMatch && req.method === "GET") {
		const artifacts = goalArtifactStore.getByGoalId(goalArtifactsMatch[1]);
		json({ artifacts });
		return;
	}

	// POST /api/goals/:goalId/artifacts — create an artifact
	if (goalArtifactsMatch && req.method === "POST") {
		const goalId = goalArtifactsMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }

		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400); return;
		}
		if (!body?.type || typeof body.type !== "string") {
			json({ error: "Missing type" }, 400); return;
		}
		if (!body?.content || typeof body.content !== "string") {
			json({ error: "Missing content" }, 400); return;
		}
		if (!body?.producedBy || typeof body.producedBy !== "string") {
			json({ error: "Missing producedBy" }, 400); return;
		}

		// Enforce workflow artifact dependency gating
		const workflowArtifactId = body.workflowArtifactId;
		if (workflowArtifactId && typeof workflowArtifactId === "string" && goal.workflow) {
			const wfArtifact = goal.workflow.artifacts.find(a => a.id === workflowArtifactId);
			if (!wfArtifact) {
				json({ error: `Unknown workflow artifact: ${workflowArtifactId}` }, 400);
				return;
			}
			if (wfArtifact.dependsOn.length > 0) {
				const existingArtifacts = goalArtifactStore.getByGoalId(goalId);
				const acceptedWfIds = new Set(
					existingArtifacts
						.filter(a => a.status === "accepted" && a.workflowArtifactId)
						.map(a => a.workflowArtifactId!)
				);
				const missing = wfArtifact.dependsOn.filter(dep => !acceptedWfIds.has(dep));
				if (missing.length > 0) {
					const missingNames = missing.map(id => {
						const def = goal.workflow!.artifacts.find(a => a.id === id);
						return def?.name || id;
					});
					json({ error: `Unmet dependencies: ${missingNames.join(", ")}`, missing }, 409);
					return;
				}
			}
		}

		// Determine initial status: if workflow artifact has verification, start as "submitted"
		let initialStatus = body.status;
		const resolvedWfArtifactId = workflowArtifactId && typeof workflowArtifactId === "string" ? workflowArtifactId : undefined;
		let wfArtifactForVerification: import("./agent/workflow-store.js").WorkflowArtifact | undefined;
		if (resolvedWfArtifactId && goal.workflow) {
			wfArtifactForVerification = goal.workflow.artifacts.find(a => a.id === resolvedWfArtifactId);
			if (wfArtifactForVerification?.verification) {
				initialStatus = "submitted";
			}
		}

		const artifact = goalArtifactStore.create({
			goalId,
			name: body.name,
			type: body.type,
			content: body.content,
			producedBy: body.producedBy,
			skillId: body.skillId,
			specId: body.specId,
			workflowArtifactId: resolvedWfArtifactId,
			status: initialStatus,
		});
		json(artifact, 201);

		// Fire-and-forget verification if the workflow artifact has a verification config
		if (wfArtifactForVerification?.verification) {
			verificationHarness.verify(
				artifact.id, artifact, wfArtifactForVerification,
				goal.cwd, goal.branch, "master", goal.workflow || undefined,
			).catch(err => console.error("[verification] Error:", err));
		}
		return;
	}

	// GET /api/goals/:goalId/artifacts/:artifactId — get a specific artifact
	const goalArtifactMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/artifacts\/([^/]+)$/);
	if (goalArtifactMatch && req.method === "GET") {
		const artifact = goalArtifactStore.get(goalArtifactMatch[2]);
		if (!artifact || artifact.goalId !== goalArtifactMatch[1]) {
			json({ error: "Artifact not found" }, 404); return;
		}
		json(artifact);
		return;
	}

	// PUT /api/goals/:goalId/artifacts/:artifactId — revise an artifact
	if (goalArtifactMatch && req.method === "PUT") {
		const artifact = goalArtifactStore.get(goalArtifactMatch[2]);
		if (!artifact || artifact.goalId !== goalArtifactMatch[1]) {
			json({ error: "Artifact not found" }, 404); return;
		}
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const updated = goalArtifactStore.update(goalArtifactMatch[2], {
			name: body.name,
			type: body.type,
			content: body.content,
			skillId: body.skillId,
		});
		if (!updated) { json({ error: "Artifact not found" }, 404); return; }

		// Re-trigger verification on update if artifact has a workflow artifact with verification
		if (updated.workflowArtifactId) {
			const goalId = goalArtifactMatch[1];
			const goal = sessionManager.goalManager.getGoal(goalId);
			if (goal?.workflow) {
				const wfArt = goal.workflow.artifacts.find(a => a.id === updated.workflowArtifactId);
				if (wfArt?.verification) {
					// Reset status to submitted and re-verify
					goalArtifactStore.update(updated.id, { status: "submitted", verificationResult: undefined, rejectionReason: undefined });
					updated.status = "submitted";
					verificationHarness.verify(
						updated.id, updated, wfArt,
						goal.cwd, goal.branch, "master", goal.workflow || undefined,
					).catch(err => console.error("[verification] Error:", err));
				}
			}
		}

		json(updated);
		return;
	}

	// GET /api/goals/:goalId/workflow-context/:workflowArtifactId — get dependency context for a workflow artifact
	const workflowContextMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/);
	if (workflowContextMatch && req.method === "GET") {
		const goalId = workflowContextMatch[1];
		const workflowArtifactId = workflowContextMatch[2];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
		const wfArtifact = goal.workflow.artifacts.find(a => a.id === workflowArtifactId);
		if (!wfArtifact) { json({ error: "Workflow artifact not found" }, 404); return; }

		const context = teamManager.buildDependencyContext(goalId, workflowArtifactId);
		json({ context, workflowArtifact: wfArtifact });
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
				const task = sessionManager.taskManager.getTask(id);
				const prevState = task?.state;
				const ok = sessionManager.taskManager.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
				});
				if (!ok) { json({ error: "Task not found" }, 404); return; }

				// Notify team lead when state transitions to terminal or blocked via PUT
				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

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
			const taskId = taskTransitionMatch[1];
			const task = sessionManager.taskManager.getTask(taskId);
			const ok = sessionManager.taskManager.transitionTask(taskId, state as TaskState);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Notify team lead when a task reaches a terminal or blocked state
			if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
				teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
			}

			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// ── Team endpoints ─────────────────────────────────────────────
	// Routes accept both /team/ and legacy /swarm/ paths

	// POST /api/goals/:id/team/start — start a team for a goal
	const teamStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/);
	if (teamStartMatch && req.method === "POST") {
		const goalId = teamStartMatch[1];
		try {
			const session = await teamManager.startTeam(goalId);
			json({ sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json({ error: "Missing role or task" }, 400);
			return;
		}
		try {
			const spawnOpts: { personalities?: string[]; workflowArtifactId?: string; inputArtifactIds?: string[] } = {};
			if (Array.isArray(body.personalities)) spawnOpts.personalities = body.personalities as string[];
			if (typeof body.workflowArtifactId === "string") spawnOpts.workflowArtifactId = body.workflowArtifactId;
			if (Array.isArray(body.inputArtifactIds)) spawnOpts.inputArtifactIds = body.inputArtifactIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(result, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/team/dismiss — dismiss a role agent
	const teamDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/);
	if (teamDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = await teamManager.dismissRole(body.sessionId);
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
		if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
		const branch = goal.branch || "HEAD";
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
		const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
		const execOpts = { cwd: goal.cwd, encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], timeout: 5000 };
		try {
			// Determine primary branch to exclude inherited commits
			let primaryBranch = "master";
			try {
				const remoteHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", execOpts).trim();
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { execSync("git rev-parse --verify refs/heads/master", execOpts); primaryBranch = "master"; }
				catch { try { execSync("git rev-parse --verify refs/heads/main", execOpts); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			// Use range notation to show only commits unique to goal branch
			// Fall back to plain log if the branch IS the primary branch or range fails
			let rangeSpec = `-${limit} ${branch}`;
			if (branch !== primaryBranch && branch !== "HEAD") {
				const primaryRef = (() => {
					try { execSync(`git rev-parse --verify origin/${primaryBranch}`, execOpts); return `origin/${primaryBranch}`; }
					catch { return primaryBranch; }
				})();
				try {
					// Test that the range is valid
					execSync(`git rev-parse ${primaryRef}`, execOpts);
					rangeSpec = `-${limit} ${primaryRef}..${branch}`;
				} catch { /* fall back to plain log */ }
			}

			const out = execSync(`git log --format="%H|%h|%s|%an|%aI" ${rangeSpec}`, {
				cwd: goal.cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
			});
			const commits = out.trim().split("\n").filter(Boolean).map((line: string) => {
				const [sha, shortSha, message, author, timestamp] = line.split("|");
				return { sha, shortSha, message, author, timestamp };
			});
			json({ commits });
		} catch (e: any) {
			json({ error: "Failed to read git log", detail: e.message }, 500);
		}
		return;
	}

	// GET /api/goals/:id/git-status — git status for goal worktree
	const goalGitMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-status$/);
	if (goalGitMatch && req.method === "GET") {
		const goalId = goalGitMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const execOpts = { cwd, encoding: "utf-8" as const, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
		try {
			let branch = "";
			try {
				branch = execSync("git rev-parse --abbrev-ref HEAD", execOpts).trim();
			} catch {
				json({ error: "Not a git repository" }, 400);
				return;
			}
			let primaryBranch = "master";
			try {
				const remoteHead = execSync("git symbolic-ref refs/remotes/origin/HEAD", execOpts).trim();
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { execSync("git rev-parse --verify refs/heads/master", execOpts); primaryBranch = "master"; }
				catch { try { execSync("git rev-parse --verify refs/heads/main", execOpts); primaryBranch = "main"; } catch { /* keep default */ } }
			}
			const isOnPrimary = branch === primaryBranch;
			let aheadOfPrimary = 0;
			let behindPrimary = 0;
			let mergedIntoPrimary = false;
			if (!isOnPrimary) {
				const primaryRef = (() => {
					try { execSync(`git rev-parse --verify origin/${primaryBranch}`, execOpts); return `origin/${primaryBranch}`; }
					catch { return primaryBranch; }
				})();
				try { aheadOfPrimary = parseInt(execSync(`git rev-list --count ${primaryRef}..HEAD`, execOpts).trim(), 10) || 0; } catch { /* ignore */ }
				try { behindPrimary = parseInt(execSync(`git rev-list --count HEAD..${primaryRef}`, execOpts).trim(), 10) || 0; } catch { /* ignore */ }
				mergedIntoPrimary = aheadOfPrimary === 0;
			}
			let statusRaw = "";
			try { statusRaw = execSync("git status --porcelain", execOpts).replace(/\s+$/, ""); } catch { /* empty */ }
			const clean = !statusRaw;
			json({ branch, primaryBranch, isOnPrimary, clean, aheadOfPrimary, behindPrimary, mergedIntoPrimary });
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// GET /api/goals/:id/team — get team state
	const teamStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)$/);
	if (teamStateMatch && req.method === "GET") {
		const goalId = teamStateMatch[1];
		const state = teamManager.getTeamState(goalId);
		if (!state) {
			json({ error: "No active team for this goal" }, 404);
			return;
		}
		json(state);
		return;
	}

	// POST /api/goals/:id/team/steer — steer a team agent mid-turn
	const teamSteerMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/);
	if (teamSteerMatch && req.method === "POST") {
		const goalId = teamSteerMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		if (session.status !== "streaming") {
			json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return;
		}
		try {
			await session.rpcClient.steer(body.message);
			json({ ok: true, dispatched: true });
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// POST /api/goals/:id/team/abort — force-abort a stuck team agent
	const teamAbortMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/);
	if (teamAbortMatch && req.method === "POST") {
		const goalId = teamAbortMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		try {
			await sessionManager.forceAbort(body.sessionId);
			const afterSession = sessionManager.getSession(body.sessionId);
			json({ ok: true, status: afterSession?.status || "idle" });
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// POST /api/goals/:id/team/prompt — send a prompt to a team agent (queued or immediate)
	const teamPromptMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/);
	if (teamPromptMatch && req.method === "POST") {
		const goalId = teamPromptMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		try {
			await sessionManager.enqueuePrompt(body.sessionId, body.message);
			json({ ok: true, status: session.status === "idle" ? "dispatched" : "queued" });
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// GET /api/goals/:id/team/agents — list agents for a team goal
	const teamAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/);
	if (teamAgentsMatch && req.method === "GET") {
		const goalId = teamAgentsMatch[1];
		json({ agents: teamManager.listAgents(goalId) });
		return;
	}

	// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
	const teamCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/);
	if (teamCompleteMatch && req.method === "POST") {
		const goalId = teamCompleteMatch[1];
		try {
			await teamManager.completeTeam(goalId);
			json({ ok: true });
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead)
	const teamTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/);
	if (teamTeardownMatch && req.method === "POST") {
		const goalId = teamTeardownMatch[1];
		try {
			await teamManager.teardownTeam(goalId);
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
			if (body.colorIndex < 0 || body.colorIndex > 13) {
				json({ error: "colorIndex must be 0-13" }, 400);
				return;
			}
			colorStore.set(id, body.colorIndex);
		}

		if (typeof body.preview === "boolean") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			session.preview = body.preview;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}

		// Track whether roleId handling already took care of personalities
		let roleHandledPersonalities = false;

		if (typeof body.roleId === "string" && body.roleId !== "") {
			const role = roleManager.getRole(body.roleId);
			if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
			// If personalities are also present, validate and pass them to assignRole to avoid double restart
			let assignOpts: { personalities?: string[] } | undefined;
			if (Array.isArray(body.personalities)) {
				const newPersonalities = body.personalities as string[];
				const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
				if (invalid.length > 0) {
					json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
					return;
				}
				assignOpts = { personalities: newPersonalities };
				roleHandledPersonalities = true;
			}
			try {
				const ok = await sessionManager.assignRole(id, role, assignOpts);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				json({ error: String(err) }, 400);
				return;
			}
		} else if (typeof body.roleId === "string" && body.roleId === "") {
			// Clear role assignment
			const session = sessionManager.getSession(id);
			if (session) {
				session.role = undefined;
				session.accessory = undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (typeof body.assistantType === "string" || typeof body.goalAssistant === "boolean" || typeof body.goalId === "string") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			if (typeof body.assistantType === "string") session.assistantType = body.assistantType || undefined;
			else if (typeof body.goalAssistant === "boolean") session.assistantType = body.goalAssistant ? "goal" : undefined;
			if (typeof body.goalId === "string") session.goalId = body.goalId;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}

		if (typeof body.accessory === "string") {
			const session = sessionManager.getSession(id);
			if (session) {
				session.accessory = body.accessory || undefined;
				sessionManager.persistSessionMetadata(session).catch(() => {});
			}
		}

		if (Array.isArray(body.personalities) && !roleHandledPersonalities) {
			const newPersonalities = body.personalities as string[];
			// Validate personality names
			const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
			if (invalid.length > 0) {
				json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return;
			}
			try {
				const ok = await sessionManager.updatePersonalities(id, newPersonalities);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				json({ error: String(err) }, 400);
				return;
			}
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

	// GET /api/skills — list available skill definitions
	if (url.pathname === "/api/skills" && req.method === "GET") {
		json({ skills: listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description })) });
		return;
	}

	// ── Workflow endpoints ──────────────────────────────────────────

	// POST /api/workflows/:id/clone (must be checked BEFORE single-workflow route)
	const workflowCloneMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/clone$/);
	if (workflowCloneMatch && req.method === "POST") {
		const id = decodeURIComponent(workflowCloneMatch[1]);
		try {
			const cloned = workflowManager.cloneWorkflow(id);
			json(cloned, 201);
		} catch (err: any) {
			json({ error: err.message }, 404);
		}
		return;
	}

	// GET /api/workflows
	const workflowsMatch = url.pathname === "/api/workflows";
	if (workflowsMatch && req.method === "GET") {
		json({ workflows: workflowManager.listWorkflows() });
		return;
	}

	// POST /api/workflows
	if (workflowsMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		try {
			const workflow = workflowManager.createWorkflow({
				id: body.id,
				name: body.name,
				description: body.description,
				artifacts: body.artifacts || [],
			});
			json(workflow, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// GET /api/workflows/:id
	const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
	if (workflowMatch && req.method === "GET") {
		const wf = workflowManager.getWorkflow(decodeURIComponent(workflowMatch[1]));
		if (!wf) { json({ error: "Workflow not found" }, 404); return; }
		json(wf);
		return;
	}

	// PUT /api/workflows/:id
	if (workflowMatch && req.method === "PUT") {
		const id = decodeURIComponent(workflowMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		try {
			const ok = workflowManager.updateWorkflow(id, body);
			if (!ok) { json({ error: "Workflow not found" }, 404); return; }
			const updated = workflowManager.getWorkflow(id);
			json(updated);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// DELETE /api/workflows/:id
	if (workflowMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowMatch[1]);
		const wf = workflowManager.getWorkflow(id);
		if (!wf) { json({ error: "Workflow not found" }, 404); return; }
		// Check if any active goal references this workflow
		const allGoals = sessionManager.goalManager.listGoals();
		if (allGoals.some((g: any) => g.workflowId === id && g.state !== "complete")) {
			json({ error: "Cannot delete: workflow is in use by active goals" }, 409);
			return;
		}
		workflowManager.deleteWorkflow(id);
		res.writeHead(204);
		res.end();
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

	// GET /api/preview?sessionId=xxx — get preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(piDir(), `preview-${sessionId}.html`)
			: path.join(piDir(), "preview.html");
		try {
			const content = fs.readFileSync(previewPath, "utf-8");
			const stat = fs.statSync(previewPath);
			json({ html: content, mtime: stat.mtimeMs });
		} catch {
			json({ html: "", mtime: 0 });
		}
		return;
	}

	// POST /api/preview?sessionId=xxx — set preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(piDir(), `preview-${sessionId}.html`)
			: path.join(piDir(), "preview.html");
		fs.writeFileSync(previewPath, body?.html || "", "utf-8");
		json({ ok: true });
		return;
	}

	// ── Background process endpoints ──────────────────────────────

	// POST /api/sessions/:id/bg-processes — create a background process
	const bgCreateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes$/);
	if (bgCreateMatch && req.method === "POST") {
		const id = bgCreateMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const body = await readBody(req);
		if (!body?.command) { json({ error: "command is required" }, 400); return; }
		const info = bgProcessManager.create(id, body.command, session.cwd);
		json(info, 201);
		return;
	}

	// GET /api/sessions/:id/bg-processes — list background processes
	if (bgCreateMatch && req.method === "GET") {
		const id = bgCreateMatch[1];
		json({ processes: bgProcessManager.list(id) });
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/logs — get logs
	const bgLogsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/);
	if (bgLogsMatch && req.method === "GET") {
		const [, sessionId, processId] = bgLogsMatch;
		const logs = bgProcessManager.getLogs(sessionId, processId);
		if (!logs) { json({ error: "Process not found" }, 404); return; }
		const tail = parseInt(url.searchParams.get("tail") || "200", 10);
		json({
			log: logs.log.slice(-tail),
			stdout: logs.stdout.slice(-tail),
			stderr: logs.stderr.slice(-tail),
		});
		return;
	}

	// DELETE /api/sessions/:id/bg-processes/:pid — kill or remove a background process
	const bgKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/);
	if (bgKillMatch && req.method === "DELETE") {
		const [, sessionId, processId] = bgKillMatch;
		// Try kill first (running), then remove (exited)
		const killed = bgProcessManager.kill(sessionId, processId);
		if (!killed) {
			const removed = bgProcessManager.remove(sessionId, processId);
			if (!removed) { json({ error: "Process not found" }, 404); return; }
		}
		json({ ok: true });
		return;
	}
	// ── Staff endpoints ────────────────────────────────────────────

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		json({ staff: staffManager.listStaff() });
		return;
	}

	// POST /api/staff
	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400);
			return;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json({ error: "Missing systemPrompt" }, 400);
			return;
		}
		const cwd = body.cwd || config.defaultCwd;
		const staff = await staffManager.createStaff(
			body.name,
			body.description || "",
			body.systemPrompt,
			cwd,
			sessionManager,
			{ triggers: body.triggers, roleId: body.roleId },
		);
		json(staff, 201);
		return;
	}

	// Routes with staff :id parameter
	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
			json(staff);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: body.cwd,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
			});
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json(staffManager.getStaff(id));
			return;
		}

		if (req.method === "DELETE") {
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// POST /api/staff/:id/wake — manually trigger a wake cycle
	const staffWakeMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/wake$/);
	if (staffWakeMatch && req.method === "POST") {
		const id = staffWakeMatch[1];
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		try {
			const sessionId = await staffManager.wake(id, body?.prompt, sessionManager);
			json({ sessionId }, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// GET /api/staff/:id/sessions — DEPRECATED (staff agents have a single permanent session)
	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json({ error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return;
	}

	json({ error: "Not found" }, 404);
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
