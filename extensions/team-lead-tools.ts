/**
 * Team Lead tool extensions for Bobbit.
 *
 * Registers team management tools (spawn, dismiss, list, complete) for team lead
 * sessions only. Task and artifact tools are in goal-tools.ts, which is loaded
 * automatically for ALL goal sessions.
 *
 * Calls the gateway REST API directly — no CLI wrapper needed.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

// Also register goal-tools (task + artifact management)
import goalTools from "./goal-tools.js";

export default function (pi: ExtensionAPI) {
	// Register goal tools first (task_list, task_create, artifact_create, etc.)
	goalTools(pi);

	// Self-signed TLS
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		console.error("[team-lead-tools] Missing BOBBIT_SESSION_ID or BOBBIT_GOAL_ID — tools not registered");
		return;
	}

	let token: string;
	let baseUrl: string;
	try {
		const piDir = path.join(homedir(), ".pi");
		token = fs.readFileSync(path.join(piDir, "gateway-token"), "utf-8").trim();
		baseUrl = fs.readFileSync(path.join(piDir, "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
	} catch {
		console.error("[team-lead-tools] Cannot read gateway credentials — tools not registered");
		return;
	}

	// ── HTTP helper ───────────────────────────────────────────────────
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) {
			const msg = typeof data === "object" && data !== null && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${resp.status}: ${text}`;
			throw new Error(msg);
		}
		return data;
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}

	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	// ── Team tools (team lead only) ───────────────────────────────────

	pi.registerTool({
		name: "team_spawn",
		label: "Spawn Team Agent",
		description: "Spawn a new role agent with its own git worktree. Returns the new session ID and worktree path.",
		promptSnippet: "Spawn a coder, reviewer, or tester agent with a task description.",
		parameters: Type.Object({
			role: Type.String({ description: "Agent role: 'coder', 'reviewer', or 'tester'" }),
			task: Type.String({ description: "Task description sent as the agent's first prompt" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/spawn`, { role: params.role, task: params.task }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_list",
		label: "List Team Agents",
		description: "List all active agents in the team with their role, status, worktree path, and task.",
		promptSnippet: "List all agents in the team with their status.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/team/agents`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_dismiss",
		label: "Dismiss Team Agent",
		description: "Terminate a role agent and clean up its git worktree.",
		promptSnippet: "Dismiss (terminate) a team agent by session ID.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session ID of the agent to dismiss" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/dismiss`, { sessionId: params.session_id }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "team_complete",
		label: "Complete Team",
		description: "Dismiss all role agents and mark the goal as complete. The team lead stays active to present a report.",
		promptSnippet: "Complete the team: dismiss all agents, keep team lead active.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/team/complete`, {}));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[team-lead-tools] Registered 4 team tools for session ${sessionId}, goal ${goalId}`);
}
