/**
 * Goal tool extensions for Bobbit.
 *
 * Registers task and artifact management tools for ANY session associated
 * with a goal. Loaded automatically via --extension when a session has a goalId.
 *
 * Team-specific tools (team_spawn, team_dismiss, etc.) live in team-lead-tools.ts
 * and are only loaded for team lead sessions.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	// Self-signed TLS
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		console.error("[goal-tools] Missing BOBBIT_SESSION_ID or BOBBIT_GOAL_ID — tools not registered");
		return;
	}

	let token: string;
	let baseUrl: string;
	try {
		const piDir = path.join(homedir(), ".pi");
		token = fs.readFileSync(path.join(piDir, "gateway-token"), "utf-8").trim();
		baseUrl = fs.readFileSync(path.join(piDir, "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
	} catch {
		console.error("[goal-tools] Cannot read gateway credentials — tools not registered");
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

	// ── Task tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		description: "List all tasks for the current goal with their state, type, assignment, and dependencies.",
		promptSnippet: "List all tasks for the goal.",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/tasks`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "task_create",
		label: "Create Task",
		description: [
			"Create a new task for the goal.",
			"Types: implementation, code-review, testing, bug-fix, refactor, custom.",
			"The server enforces artifact requirements — if a required artifact is missing, this returns a 409 error listing what's needed.",
		].join(" "),
		promptSnippet: "Create a task with title, type, optional spec, and dependencies.",
		parameters: Type.Object({
			title: Type.String({ description: "Short task title" }),
			type: Type.String({ description: "Task type: implementation, code-review, testing, bug-fix, refactor, or custom" }),
			spec: Type.Optional(Type.String({ description: "Detailed specification for the task" })),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task depends on" })),
			workflowArtifactId: Type.Optional(Type.String({ description: "Workflow artifact ID this task should produce. Used for context injection when the agent is prompted." })),
			inputArtifactIds: Type.Optional(Type.Array(Type.String(), { description: "Workflow artifact IDs whose accepted content to inject when prompting the assigned agent." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { title: params.title, type: params.type };
				if (params.spec) body.spec = params.spec;
				if (params.depends_on?.length) body.dependsOn = params.depends_on;
				if (params.workflowArtifactId) body.workflowArtifactId = params.workflowArtifactId;
				if (params.inputArtifactIds?.length) body.inputArtifactIds = params.inputArtifactIds;
				return ok(await api("POST", `/api/goals/${goalId}/tasks`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Update Task",
		description: [
			"Update a task's fields, assignment, and/or state in a single call.",
			"Provide any combination: field updates (title, spec, result_summary, commit_sha),",
			"assignment (assigned_to session ID), and/or state transition (state).",
			"States: todo, in-progress, blocked, complete, skipped.",
		].join(" "),
		promptSnippet: "Update task fields, assign to a session, and/or transition state.",
		parameters: Type.Object({
			task_id: Type.String({ description: "Task ID" }),
			title: Type.Optional(Type.String({ description: "New title" })),
			spec: Type.Optional(Type.String({ description: "New spec" })),
			result_summary: Type.Optional(Type.String({ description: "Summary of results" })),
			commit_sha: Type.Optional(Type.String({ description: "Commit SHA" })),
			assigned_to: Type.Optional(Type.String({ description: "Session ID to assign task to" })),
			state: Type.Optional(Type.String({ description: "Transition to: todo, in-progress, blocked, complete, skipped" })),
		}),
		async execute(_id, params) {
			try {
				const { task_id, assigned_to, state, ...fields } = params;
				// Update fields
				const updateBody: Record<string, unknown> = {};
				if (fields.title !== undefined) updateBody.title = fields.title;
				if (fields.spec !== undefined) updateBody.spec = fields.spec;
				if (fields.result_summary !== undefined) updateBody.resultSummary = fields.result_summary;
				if (fields.commit_sha !== undefined) updateBody.commitSha = fields.commit_sha;
				if (Object.keys(updateBody).length > 0) {
					await api("PUT", `/api/tasks/${task_id}`, updateBody);
				}
				// Assign
				if (assigned_to) {
					await api("POST", `/api/tasks/${task_id}/assign`, { sessionId: assigned_to });
				}
				// Transition
				if (state) {
					await api("POST", `/api/tasks/${task_id}/transition`, { state });
				}
				// Return current task state
				return ok(await api("GET", `/api/tasks/${task_id}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	// ── Artifact tools ────────────────────────────────────────────────

	pi.registerTool({
		name: "artifact_list",
		label: "List Artifacts",
		description: "List all artifacts for the goal (name, type, version, timestamps). Does not include content — use artifact_get for that.",
		promptSnippet: "List all goal artifacts (metadata only, no content).",
		parameters: Type.Object({}),
		async execute() {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/artifacts`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "artifact_create",
		label: "Create Artifact",
		description: [
			"Create a goal artifact. Types: design-doc (blocks implementation tasks),",
			"test-plan, review-findings (blocks goal completion), gap-analysis, security-findings, pr, custom.",
		].join(" "),
		promptSnippet: "Create a goal artifact (design-doc, review-findings, test-plan, etc.).",
		parameters: Type.Object({
			name: Type.String({ description: "Human-readable artifact name" }),
			type: Type.String({ description: "Artifact type: design-doc, test-plan, review-findings, gap-analysis, security-findings, pr, or custom" }),
			content: Type.String({ description: "Artifact content (markdown or JSON)" }),
			workflowArtifactId: Type.Optional(Type.String({ description: "Workflow artifact ID this fulfils. Links the artifact to a workflow definition and enforces dependency gating." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = {
					name: params.name,
					type: params.type,
					content: params.content,
					producedBy: sessionId,
				};
				if (params.workflowArtifactId) body.workflowArtifactId = params.workflowArtifactId;
				return ok(await api("POST", `/api/goals/${goalId}/artifacts`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "artifact_get",
		label: "Get Artifact",
		description: "Get a specific artifact including its full content.",
		promptSnippet: "Get an artifact's full content by ID.",
		parameters: Type.Object({
			artifact_id: Type.String({ description: "Artifact ID" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("GET", `/api/goals/${goalId}/artifacts/${params.artifact_id}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "artifact_update",
		label: "Update Artifact",
		description: "Update an artifact's content. Increments the version number.",
		promptSnippet: "Update an artifact's content (increments version).",
		parameters: Type.Object({
			artifact_id: Type.String({ description: "Artifact ID" }),
			content: Type.String({ description: "New content (markdown or JSON)" }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("PUT", `/api/goals/${goalId}/artifacts/${params.artifact_id}`, {
					content: params.content,
				}));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[goal-tools] Registered 7 task/artifact tools for session ${sessionId}, goal ${goalId}`);
}
