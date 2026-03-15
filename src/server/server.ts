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
	const colorStore = new ColorStore();
	const rateLimiter = new RateLimiter();
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// API routes
		if (url.pathname.startsWith("/api/")) {
			// When serving the UI (same-origin), reflect the request origin; otherwise allow any
			const corsOrigin = config.staticDir ? (req.headers.origin || "*") : "*";
			res.setHeader("Access-Control-Allow-Origin", corsOrigin);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

			await handleApiRoute(url, req, res, sessionManager, config, colorStore);
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

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const body = await readBody(req);
		const goalId = body?.goalId;
		const goalAssistant = body?.goalAssistant === true;

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
			const session = await sessionManager.createSession(cwd, args, goalId, goalAssistant);
			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				goalId: session.goalId,
				goalAssistant: session.goalAssistant,
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
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		const goal = sessionManager.goalManager.createGoal(title, cwd, spec);
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
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			sessionManager.goalManager.deleteGoal(id);
			json({ ok: true });
			return;
		}
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

	// Delegate logs — serve JSONL log files from delegate agent runs
	// Default: serves an HTML viewer; ?format=raw for raw JSONL
	const delegateLogMatch = url.pathname.match(/^\/api\/delegate-logs\/([a-zA-Z0-9_-]+)$/);
	if (delegateLogMatch && req.method === "GET") {
		const logId = delegateLogMatch[1];
		const logPath = path.join(os.homedir(), ".pi", "delegate-logs", `${logId}.jsonl`);
		// Path traversal guard
		const resolvedLog = path.resolve(logPath);
		const resolvedDir = path.resolve(path.join(os.homedir(), ".pi", "delegate-logs"));
		if (!resolvedLog.startsWith(resolvedDir)) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Invalid log ID");
			return;
		}
		if (!fs.existsSync(logPath)) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Log not found");
			return;
		}

		const format = url.searchParams.get("format");
		if (format === "raw") {
			// Raw JSONL
			res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
			const stream = fs.createReadStream(logPath);
			stream.pipe(res);
			return;
		}

		// HTML log viewer — builds a raw URL that preserves the auth token
		const token = url.searchParams.get("token");
		const rawUrl = `/api/delegate-logs/${logId}?format=raw${token ? `&token=${encodeURIComponent(token)}` : ""}`;
		const { generateLogViewerHtml } = await import("./workflows/log-viewer.js");
		const html = generateLogViewerHtml(logId, rawUrl);
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
		res.end(html);
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
