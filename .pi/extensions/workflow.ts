/**
 * Workflow Extension
 *
 * Registers a `workflow` tool that allows the agent to manage workflow execution:
 * - List available workflows
 * - Start a workflow
 * - Advance to the next phase
 * - Reset to an earlier phase
 * - Collect artifacts (text output, logs, etc.)
 * - Set context key-value pairs
 * - Complete, fail, or cancel a workflow
 * - Get current workflow status
 *
 * The workflow engine tracks progress, persists state, and generates HTML reports.
 * Reports are served via the Bobbit gateway REST API.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Inline workflow engine (extension runs inside the agent process,
//    not the gateway, so we can't import from src/server/workflows) ──

const STATE_DIR = path.join(os.homedir(), ".pi", "workflow-state");
const ARTIFACTS_DIR = path.join(os.homedir(), ".pi", "workflow-artifacts");

interface Phase {
	id: string;
	name: string;
	instructions: string;
	exitCriteria: string;
}

interface Workflow {
	id: string;
	name: string;
	description: string;
	phases: Phase[];
}

interface PhaseRecord {
	phaseId: string;
	startedAt: number;
	completedAt?: number;
	status: "active" | "completed" | "skipped" | "reset";
}

interface WorkflowArtifact {
	name: string;
	filePath: string;
	mimeType: string;
	collectedAt: number;
	phaseId?: string;
}

interface WorkflowState {
	workflowId: string;
	sessionId: string;
	status: "running" | "completed" | "failed" | "cancelled";
	currentPhaseIndex: number;
	phaseHistory: PhaseRecord[];
	artifacts: WorkflowArtifact[];
	startedAt: number;
	completedAt?: number;
	reportPath?: string;
	context: Record<string, string>;
}

// ── Built-in workflow definitions ──

const WORKFLOWS: Workflow[] = [
	{
		id: "test-suite-report",
		name: "Test Suite Report",
		description:
			"Creates a git worktree, builds the project, runs tests, and generates an HTML report with results.",
		phases: [
			{
				id: "create-worktree",
				name: "Create Worktree",
				instructions: `Create an isolated git worktree for running the test suite.
1. Pick a branch name like \`test-run-{timestamp}\`
2. Run: \`git worktree add -b {branch} {worktree-path} HEAD\`
3. The worktree should be a sibling directory of the main repo
4. Use the workflow tool to set context: branch, worktree_path
After creating the worktree, use the workflow tool to advance to the next phase.`,
				exitCriteria: "Git worktree exists on a new branch at the recorded path",
			},
			{
				id: "compile",
				name: "Compile",
				instructions: `Build the project in the worktree directory.
1. cd into the worktree path (from workflow context)
2. Run \`npm install\` if needed
3. Run the project's build command (e.g. \`npm run build\`)
4. Use the workflow tool to collect the build output as artifact "build-output.txt"
5. If the build fails, collect the error output and use workflow tool to fail the workflow
After a successful build, use the workflow tool to advance to the next phase.`,
				exitCriteria: "Project compiles successfully in the worktree",
			},
			{
				id: "run-tests",
				name: "Run Tests",
				instructions: `Run the project's test suite in the worktree.
1. cd into the worktree path (from workflow context)
2. Run the test command (e.g. \`npm test\`)
3. Use the workflow tool to collect ALL test output as artifact "test-output.txt"
4. Tests may fail — that's OK, we're generating a report
5. Set context: test_result (pass/fail), pass_count, fail_count, summary
After running tests (regardless of pass/fail), use the workflow tool to advance.`,
				exitCriteria: "Tests have been executed and output captured",
			},
			{
				id: "cleanup",
				name: "Clean Up",
				instructions: `Remove the git worktree and branch.
1. Run: \`git worktree remove {worktree-path} --force\`
2. Run: \`git worktree prune\`
3. Optionally delete the branch: \`git branch -D {branch}\`
After cleanup, use the workflow tool with action "complete" to finish. The report is generated automatically.`,
				exitCriteria: "Worktree and branch removed",
			},
		],
	},
];

const workflowMap = new Map(WORKFLOWS.map((w) => [w.id, w]));

// ── State management ──

function loadState(sessionId: string): WorkflowState | null {
	const fp = path.join(STATE_DIR, `${sessionId}.json`);
	try {
		return JSON.parse(fs.readFileSync(fp, "utf-8"));
	} catch {
		return null;
	}
}

function saveState(state: WorkflowState): void {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(STATE_DIR, `${state.sessionId}.json`),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

function storeArtifactFile(sessionId: string, filename: string, content: string): string {
	const dir = path.join(ARTIFACTS_DIR, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
	const fp = path.join(dir, safeName);
	fs.writeFileSync(fp, content, "utf-8");
	return fp;
}

// ── Report generation ──

function generateReport(workflow: Workflow, state: WorkflowState): string {
	const now = Date.now();
	const duration = (state.completedAt || now) - state.startedAt;
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const fmtTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
	const fmtDur = (ms: number) => {
		if (ms < 1000) return `${ms}ms`;
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return `${m}m ${s % 60}s`;
	};

	const ctx = state.context;
	const failed = state.status === "failed";
	const testResult = ctx.test_result || (failed ? "fail" : "unknown");
	const passCount = ctx.pass_count || "?";
	const failCount = ctx.fail_count || "?";
	const summary = ctx.summary || "";

	// Read artifact contents from disk
	const artifactContents: Record<string, string> = {};
	for (const a of state.artifacts) {
		try {
			artifactContents[a.name] = fs.readFileSync(a.filePath, "utf-8");
		} catch {
			artifactContents[a.name] = "(could not read artifact)";
		}
	}

	// Result badge
	const resultColor = testResult === "pass"
		? { bg: "#3fb950", bgFaint: "rgba(63,185,80,0.1)", text: "#3fb950" }
		: { bg: "#f85149", bgFaint: "rgba(248,81,73,0.1)", text: "#f85149" };

	// Build the evidence sections
	const buildOutput = artifactContents["build-output.txt"];
	const testOutput = artifactContents["test-output.txt"];

	const buildSection = buildOutput ? `
		<section class="evidence">
			<h2>Build Output</h2>
			<pre class="output">${esc(buildOutput)}</pre>
		</section>` : "";

	const testSection = testOutput ? `
		<section class="evidence">
			<h2>Test Results</h2>
			<div class="result-banner" style="background:${resultColor.bgFaint};border-left:3px solid ${resultColor.bg}">
				<span class="result-label" style="color:${resultColor.text}">${testResult === "pass" ? "PASSED" : "FAILED"}</span>
				<span class="result-counts">${passCount} passed, ${failCount} failed</span>
			</div>
			<pre class="output">${esc(testOutput)}</pre>
		</section>` : "";

	// Other artifacts (not build/test output)
	const otherArtifacts = state.artifacts.filter(
		(a) => a.name !== "build-output.txt" && a.name !== "test-output.txt",
	);
	const otherSections = otherArtifacts.map((a) => {
		const content = artifactContents[a.name] || "";
		return `
		<section class="evidence">
			<h2>${esc(a.name)}</h2>
			<pre class="output">${esc(content)}</pre>
		</section>`;
	}).join("\n");

	// Context info displayed as key details, not a raw table
	const branch = ctx.branch || "unknown";
	const commit = ctx.head_commit || "unknown";
	const sourceBranch = ctx.source_branch || "unknown";

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(workflow.name)}</title>
<style>
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; }
@media(prefers-color-scheme:light) {
	:root { --bg: #fff; --surface: #f6f8fa; --border: #d0d7de; --text: #1f2328; --muted: #656d76; }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
.report { max-width: 900px; margin: 0 auto; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }

/* Header */
.header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
.header h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem; }
.header-meta { display: flex; flex-wrap: wrap; gap: 1.5rem; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.75rem; }
.header-meta strong { color: var(--text); font-weight: 500; }
.summary { font-size: 1rem; margin-top: 0.5rem; }

/* Evidence sections */
.evidence { margin-bottom: 2rem; }
.evidence h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
.output { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; font-size: 0.8rem; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.result-banner { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 1rem; }
.result-label { font-weight: 700; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; }
.result-counts { font-size: 0.85rem; color: var(--muted); }

/* Footer */
.footer { padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; display: flex; flex-wrap: wrap; gap: 1.5rem; }
</style></head>
<body><div class="report">
	<div class="header">
		<h1>${esc(workflow.name)}</h1>
		<div class="header-meta">
			<span><strong>Branch:</strong> ${esc(branch)}</span>
			<span><strong>Commit:</strong> <code>${esc(commit)}</code></span>
			<span><strong>Base:</strong> ${esc(sourceBranch)}</span>
			<span><strong>Duration:</strong> ${fmtDur(duration)}</span>
		</div>
		${summary ? `<p class="summary">${esc(summary)}</p>` : ""}
	</div>

	${testSection}
	${buildSection}
	${otherSections}

	<div class="footer">
		<span>${fmtTime(state.startedAt)} → ${state.completedAt ? fmtTime(state.completedAt) : "in progress"}</span>
		<span>${state.status}</span>
		${ctx.failure_reason ? `<span>Failure: ${esc(ctx.failure_reason)}</span>` : ""}
	</div>
</div></body></html>`;
}

// ── Derive session ID from the agent session file path ──
// Agent session files live at ~/.pi/sessions/{uuid}/{file}.jsonl
// We extract the directory name as the session id.
// If unavailable, we fall back to a hash of cwd.

function getSessionId(ctx: { sessionManager: { sessionFile?: string }; cwd: string }): string {
	try {
		const sm = ctx.sessionManager as any;
		const sessionFile: string | undefined = sm.sessionFile ?? sm.currentSessionFile?.();
		if (sessionFile) {
			// ~/.pi/sessions/{uuid}/main.jsonl → uuid
			const parts = sessionFile.replace(/\\/g, "/").split("/");
			const sessionsIdx = parts.indexOf("sessions");
			if (sessionsIdx >= 0 && sessionsIdx + 1 < parts.length) {
				return parts[sessionsIdx + 1];
			}
		}
	} catch {
		// fall through
	}
	// Fallback: use a deterministic ID from cwd
	let hash = 0;
	for (const ch of ctx.cwd) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
	return `wf-${Math.abs(hash).toString(36)}`;
}

// ── Extension ──

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Manage workflow execution: list workflows, start/advance/complete them, collect artifacts, and generate reports. " +
			"Use action 'list' to see available workflows, 'start' to begin one, 'status' to check progress, " +
			"'advance' to move to the next phase, 'collect_artifact' to save output, 'set_context' to store metadata, " +
			"'complete'/'fail'/'cancel' to finish.",
		promptSnippet:
			"workflow - Manage structured workflows: start, advance phases, collect artifacts, generate HTML reports",
		promptGuidelines: [
			"When running a workflow, follow each phase's instructions carefully before advancing",
			"Always collect important output (build logs, test results) as artifacts using the workflow tool",
			"Set context values for key metadata (branch names, paths, test counts) so they appear in the report",
			"Use 'status' to check which phase you're in and what the instructions say",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("list"),
				Type.Literal("start"),
				Type.Literal("status"),
				Type.Literal("advance"),
				Type.Literal("reset"),
				Type.Literal("collect_artifact"),
				Type.Literal("set_context"),
				Type.Literal("complete"),
				Type.Literal("fail"),
				Type.Literal("cancel"),
			], { description: "The workflow action to perform" }),
			workflow_id: Type.Optional(
				Type.String({ description: "Workflow ID (required for 'start')" }),
			),
			phase_id: Type.Optional(
				Type.String({ description: "Phase ID (required for 'reset')" }),
			),
			name: Type.Optional(
				Type.String({ description: "Artifact name (required for 'collect_artifact')" }),
			),
			content: Type.Optional(
				Type.String({ description: "Artifact content (required for 'collect_artifact')" }),
			),
			mime_type: Type.Optional(
				Type.String({ description: "Artifact MIME type (default: text/plain)" }),
			),
			key: Type.Optional(
				Type.String({ description: "Context key (required for 'set_context')" }),
			),
			value: Type.Optional(
				Type.String({ description: "Context value (required for 'set_context')" }),
			),
			reason: Type.Optional(
				Type.String({ description: "Failure reason (optional for 'fail')" }),
			),
			context: Type.Optional(
				Type.String({ description: "Reset context (optional for 'reset')" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = getSessionId(ctx as any);

			switch (params.action) {
				case "list": {
					const list = WORKFLOWS.map((w) => ({
						id: w.id,
						name: w.name,
						description: w.description,
						phases: w.phases.length,
					}));
					return {
						content: [{ type: "text", text: JSON.stringify({ workflows: list }, null, 2) }],
						details: undefined,
					};
				}

				case "start": {
					if (!params.workflow_id) {
						return { content: [{ type: "text", text: "Error: workflow_id is required for 'start'" }], details: undefined };
					}
					const wf = workflowMap.get(params.workflow_id);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Unknown workflow '${params.workflow_id}'. Use action 'list' to see available workflows.` }], details: undefined };
					}
					const existing = loadState(sessionId);
					if (existing && existing.status === "running") {
						return { content: [{ type: "text", text: `Error: A workflow is already running (${existing.workflowId}). Complete or cancel it first.` }], details: undefined };
					}

					const now = Date.now();
					const state: WorkflowState = {
						workflowId: params.workflow_id,
						sessionId,
						status: "running",
						currentPhaseIndex: 0,
						phaseHistory: [{ phaseId: wf.phases[0].id, startedAt: now, status: "active" }],
						artifacts: [],
						startedAt: now,
						context: {},
					};
					saveState(state);

					const phase = wf.phases[0];
					const phaseList = wf.phases.map((p, i) => p.name).join(" → ");
					return {
						content: [{
							type: "text",
							text: `Workflow "${wf.name}" started.\n\n` +
								`Phases: ${phaseList}\n\n` +
								`## Current Phase: ${phase.name} (1/${wf.phases.length})\n\n` +
								`${phase.instructions}\n\n` +
								`**Exit criteria:** ${phase.exitCriteria}`,
						}],
						details: undefined,
					};
				}

				case "status": {
					const state = loadState(sessionId);
					if (!state) {
						return { content: [{ type: "text", text: "No active workflow. Use action 'start' to begin one." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Workflow definition '${state.workflowId}' not found.` }], details: undefined };
					}

					const phase = wf.phases[state.currentPhaseIndex];
					const lines = [
						`## Workflow: ${wf.name}`,
						`**Status:** ${state.status}`,
						`**Phase:** ${phase?.name || "done"} (${state.currentPhaseIndex + 1}/${wf.phases.length})`,
						"",
					];
					if (phase && state.status === "running") {
						lines.push(`### Instructions`, "", phase.instructions, "", `**Exit criteria:** ${phase.exitCriteria}`, "");
					}
					if (Object.keys(state.context).length > 0) {
						lines.push("### Context");
						for (const [k, v] of Object.entries(state.context)) {
							lines.push(`- **${k}:** ${v}`);
						}
						lines.push("");
					}
					if (state.artifacts.length > 0) {
						lines.push("### Artifacts");
						for (const a of state.artifacts) {
							lines.push(`- ${a.name} (${a.mimeType})`);
						}
					}
					if (state.reportPath) {
						lines.push("", `### Report`, `Report available at: /api/sessions/${sessionId}/workflow/report`);
					}

					return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
				}

				case "advance": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow to advance." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					const now = Date.now();

					// Complete current phase
					const activeRec = state.phaseHistory.find(
						(r) => r.phaseId === wf.phases[state.currentPhaseIndex]?.id && r.status === "active",
					);
					if (activeRec) {
						activeRec.status = "completed";
						activeRec.completedAt = now;
					}

					state.currentPhaseIndex++;

					if (state.currentPhaseIndex >= wf.phases.length) {
						state.status = "completed";
						state.completedAt = now;
						const html = generateReport(wf, state);
						state.reportPath = storeArtifactFile(sessionId, "report.html", html);
						saveState(state);
						return {
							content: [{
								type: "text",
								text: `All phases complete! Workflow "${wf.name}" finished.\n\n` +
									`Report generated at: /api/sessions/${sessionId}/workflow/report`,
							}],
							details: undefined,
						};
					}

					const prevPhase = wf.phases[state.currentPhaseIndex - 1];
					const nextPhase = wf.phases[state.currentPhaseIndex];
					state.phaseHistory.push({ phaseId: nextPhase.id, startedAt: now, status: "active" });
					saveState(state);

					return {
						content: [{
							type: "text",
							text: `Completed: ${prevPhase.name} | Next: ${nextPhase.name} (${state.currentPhaseIndex + 1}/${wf.phases.length})\n\n` +
								`## Current Phase: ${nextPhase.name} (${state.currentPhaseIndex + 1}/${wf.phases.length})\n\n` +
								`${nextPhase.instructions}\n\n` +
								`**Exit criteria:** ${nextPhase.exitCriteria}`,
						}],
						details: undefined,
					};
				}

				case "reset": {
					if (!params.phase_id) {
						return { content: [{ type: "text", text: "Error: phase_id is required for 'reset'" }], details: undefined };
					}
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					const targetIdx = wf.phases.findIndex((p) => p.id === params.phase_id);
					if (targetIdx < 0) {
						return { content: [{ type: "text", text: `Error: Unknown phase '${params.phase_id}'` }], details: undefined };
					}

					const now = Date.now();
					const activeRec = state.phaseHistory.find(
						(r) => r.phaseId === wf.phases[state.currentPhaseIndex]?.id && r.status === "active",
					);
					if (activeRec) {
						activeRec.status = "reset";
						activeRec.completedAt = now;
					}
					state.currentPhaseIndex = targetIdx;
					state.phaseHistory.push({ phaseId: params.phase_id, startedAt: now, status: "active" });
					if (params.context) {
						state.context[`reset_${params.phase_id}_${now}`] = params.context;
					}
					saveState(state);

					const phase = wf.phases[targetIdx];
					return {
						content: [{
							type: "text",
							text: `Reset to phase "${phase.name}".\n\n${phase.instructions}\n\n**Exit criteria:** ${phase.exitCriteria}`,
						}],
						details: undefined,
					};
				}

				case "collect_artifact": {
					if (!params.name || !params.content) {
						return { content: [{ type: "text", text: "Error: name and content are required for 'collect_artifact'" }], details: undefined };
					}
					const state = loadState(sessionId);
					if (!state) {
						return { content: [{ type: "text", text: "Error: No workflow running." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					const mimeType = params.mime_type || "text/plain";
					const filePath = storeArtifactFile(sessionId, params.name, params.content);
					const currentPhase = wf.phases[state.currentPhaseIndex];

					state.artifacts.push({
						name: params.name,
						filePath,
						mimeType,
						collectedAt: Date.now(),
						phaseId: currentPhase?.id,
					});
					saveState(state);

					return {
						content: [{ type: "text", text: `Artifact "${params.name}" collected (${mimeType}, ${params.content.length} chars).` }],
						details: undefined,
					};
				}

				case "set_context": {
					if (!params.key || params.value === undefined) {
						return { content: [{ type: "text", text: "Error: key and value are required for 'set_context'" }], details: undefined };
					}
					const state = loadState(sessionId);
					if (!state) {
						return { content: [{ type: "text", text: "Error: No workflow running." }], details: undefined };
					}
					state.context[params.key] = params.value;
					saveState(state);
					return {
						content: [{ type: "text", text: `Context set: ${params.key} = ${params.value}` }],
						details: undefined,
					};
				}

				case "complete": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					const now = Date.now();

					// Complete active phase
					const activeRec = state.phaseHistory.find(
						(r) => r.phaseId === wf.phases[state.currentPhaseIndex]?.id && r.status === "active",
					);
					if (activeRec) {
						activeRec.status = "completed";
						activeRec.completedAt = now;
					}

					state.status = "completed";
					state.completedAt = now;
					const html = generateReport(wf, state);
					state.reportPath = storeArtifactFile(sessionId, "report.html", html);
					saveState(state);

					return {
						content: [{
							type: "text",
							text: `Workflow "${wf.name}" completed!\n\nReport: /api/sessions/${sessionId}/workflow/report`,
						}],
						details: undefined,
					};
				}

				case "fail": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					state.status = "failed";
					state.completedAt = Date.now();
					if (params.reason) state.context["failure_reason"] = params.reason;
					const html = generateReport(wf, state);
					state.reportPath = storeArtifactFile(sessionId, "report.html", html);
					saveState(state);

					return {
						content: [{
							type: "text",
							text: `Workflow "${wf.name}" marked as failed.${params.reason ? ` Reason: ${params.reason}` : ""}\n\nReport: /api/sessions/${sessionId}/workflow/report`,
						}],
						details: undefined,
					};
				}

				case "cancel": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					const wf = workflowMap.get(state.workflowId)!;
					state.status = "cancelled";
					state.completedAt = Date.now();
					const html = generateReport(wf, state);
					state.reportPath = storeArtifactFile(sessionId, "report.html", html);
					saveState(state);

					return {
						content: [{ type: "text", text: `Workflow "${wf.name}" cancelled.` }],
						details: undefined,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}. Valid actions: list, start, status, advance, reset, collect_artifact, set_context, complete, fail, cancel` }],
						details: undefined,
					};
			}
		},
	});
};

export default extension;
