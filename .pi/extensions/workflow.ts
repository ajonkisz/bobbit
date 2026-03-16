/**
 * Workflow Extension
 *
 * Thin agent-side client for the Bobbit workflow engine.
 *
 * **Architecture:**
 * - Workflow definitions are canonical on the server side
 *   (`src/server/workflows/definitions/`). The server exports them to
 *   `~/.pi/workflow-definitions.json` at startup.
 * - This extension reads that file — it never hardcodes workflow definitions.
 * - State is written to `~/.pi/workflow-state/{sessionId}.json` (shared with server).
 * - Report generation is handled by the server on-demand when the report URL
 *   is requested — the extension does NOT generate reports.
 * - Sub-agent phases spawn independent agent processes with isolated context.
 * - Parallel-group phases run multiple sub-agents concurrently.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Paths (shared with server) ──

const DEFINITIONS_PATH = path.join(os.homedir(), ".pi", "workflow-definitions.json");
const STATE_DIR = path.join(os.homedir(), ".pi", "workflow-state");
const ARTIFACTS_DIR = path.join(os.homedir(), ".pi", "workflow-artifacts");

// ── Types (must match server's types.ts — keep in sync!) ──

interface Phase {
	id: string;
	name: string;
	instructions: string;
	exitCriteria: string;
	/** Run as independent sub-agent process (default: false = inline in parent) */
	subAgent?: boolean;
	/** Context isolation for sub-agents: "full" (default), "goal", or "none" */
	isolation?: "full" | "goal" | "none";
	/** Sub-phases to run concurrently (each as a sub-agent) */
	parallelPhases?: Phase[];
	/** Timeout in ms for sub-agent execution */
	timeoutMs?: number;
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
	/** Set to true when run_phase was executed for this phase */
	ranRunPhase?: boolean;
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

// ── Load definitions from server-exported file ──

function loadDefinitions(): Map<string, Workflow> {
	const map = new Map<string, Workflow>();
	try {
		const data = JSON.parse(fs.readFileSync(DEFINITIONS_PATH, "utf-8"));
		if (data.workflows && Array.isArray(data.workflows)) {
			for (const w of data.workflows) {
				if (w.id && w.phases) map.set(w.id, w);
			}
		}
	} catch {
		// File may not exist yet (server hasn't started), or is malformed.
	}
	return map;
}

let _cachedWorkflows: Map<string, Workflow> | null = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 5_000;

function getWorkflows(): Map<string, Workflow> {
	const now = Date.now();
	if (!_cachedWorkflows || now - _cacheTime > CACHE_TTL_MS) {
		_cachedWorkflows = loadDefinitions();
		_cacheTime = now;
	}
	return _cachedWorkflows;
}

// ── State management (writes to shared location, server can also read/write) ──

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

// ── Session ID resolution ──

/** Cached fallback session ID — generated once per process so all calls within the same
 *  agent session get a consistent ID even if the real session file isn't accessible. */
let _fallbackSessionId: string | null = null;

function getSessionId(ctx: { sessionManager: { sessionFile?: string }; cwd: string }): string {
	try {
		const sm = ctx.sessionManager as any;
		const sessionFile: string | undefined = sm.sessionFile ?? sm.currentSessionFile?.();
		if (sessionFile) {
			const parts = sessionFile.replace(/\\/g, "/").split("/");
			const sessionsIdx = parts.indexOf("sessions");
			if (sessionsIdx >= 0 && sessionsIdx + 1 < parts.length) {
				return parts[sessionsIdx + 1];
			}
		}
	} catch {
		// fall through
	}
	// Fallback: generate a unique ID per agent process so different sessions
	// in the same cwd don't share workflow state.
	if (!_fallbackSessionId) {
		_fallbackSessionId = `wf-${randomUUID().slice(0, 12)}`;
	}
	return _fallbackSessionId;
}

// ── Phase execution helpers ──

/** Is this phase a parallel group (has parallelPhases)? */
function isParallelGroup(phase: Phase): boolean {
	return Array.isArray(phase.parallelPhases) && phase.parallelPhases.length > 0;
}

/** Does this phase require sub-agent execution? */
function isSubAgentPhase(phase: Phase): boolean {
	return phase.subAgent === true || isParallelGroup(phase);
}

/** Describe the execution mode for display */
function describeExecution(phase: Phase): string {
	if (isParallelGroup(phase)) {
		const count = phase.parallelPhases!.length;
		return `parallel-group (${count} sub-agents)`;
	}
	if (phase.subAgent) {
		const iso = phase.isolation || "full";
		return `sub-agent (isolation: ${iso})`;
	}
	return "inline";
}

/**
 * Format the execution note appended to phase instructions.
 * For sub-agent/parallel phases, returns a strong imperative directive.
 * For inline phases, returns empty string.
 */
function formatPhaseExecNote(phase: Phase): string {
	if (isParallelGroup(phase)) {
		return `\n\n---\n**Your only action for this phase:** call the workflow tool with \`action: "run_phase"\`. ` +
			`The tool handles everything internally and returns the results. ` +
			`Do NOT do the work yourself. \`advance\` is blocked until \`run_phase\` has been called.`;
	}
	if (phase.subAgent) {
		return `\n\n---\n**Your only action for this phase:** call the workflow tool with \`action: "run_phase"\`. ` +
			`The tool handles everything internally and returns the results. ` +
			`Do NOT do the work yourself. \`advance\` is blocked until \`run_phase\` has been called.`;
	}
	return "";
}

// ── Delegate integration (uses session-based delegates via gateway API) ──

import { runDelegateSession, createDelegateSession, waitForDelegate, getParentSessionId } from "./delegate";
import type { DelegateResult } from "./delegate";
import { randomUUID } from "node:crypto";

/** Build instructions string for a phase delegate */
function buildPhaseInstructions(phase: Phase, context: Record<string, string>): string {
	const lines: string[] = [];
	lines.push(`# Workflow Phase: ${phase.name}\n`);
	lines.push(phase.instructions);
	lines.push(`\n**Exit criteria:** ${phase.exitCriteria}`);
	if (Object.keys(context).length > 0) {
		lines.push(`\n## Context`);
		for (const [k, v] of Object.entries(context)) {
			lines.push(`- **${k}:** ${v}`);
		}
	}
	return lines.join("\n");
}

/** Run a single phase as a delegate session, returning result with phaseId */
async function runPhaseDelegate(
	parentSessionId: string,
	phase: Phase,
	context: Record<string, string>,
	cwd: string,
	signal?: AbortSignal,
): Promise<DelegateResult & { phaseId: string }> {
	const instructions = buildPhaseInstructions(phase, context);
	const timeoutMs = phase.timeoutMs ?? 600_000;
	const result = await runDelegateSession(
		parentSessionId,
		instructions,
		cwd,
		timeoutMs,
		signal,
		{ title: `⚡ ${phase.name}`, context },
	);
	return { ...result, phaseId: phase.id };
}

// ── Extension ──

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Manage workflow execution: list workflows, start/advance/complete them, collect artifacts, generate reports, " +
			"and run delegated phases. Use action 'list' to see available workflows, 'start' to begin one, 'status' to check progress, " +
			"'advance' to move to the next phase, 'run_phase' to execute a delegated phase (uses the delegate tool internally), " +
			"'collect_artifact' to save output, 'set_context' to store metadata, 'complete'/'fail'/'cancel' to finish.",
		promptSnippet:
			"workflow - Manage structured workflows: start, advance phases, delegate phases to independent agents, collect artifacts, generate reports",
		promptGuidelines: [
			"When running a workflow, follow each phase's instructions carefully before advancing",
			"Some phases are delegated — for these, your ONLY action is to call this tool with action 'run_phase' and wait for it to return. The tool handles execution internally. You cannot advance past these phases without calling run_phase first — advance will return an error.",
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
				Type.Literal("run_phase"),
				Type.Literal("collect_artifact"),
				Type.Literal("set_context"),
				Type.Literal("complete"),
				Type.Literal("fail"),
				Type.Literal("cancel"),
			], { description: "The workflow action to perform. 'run_phase' executes a delegated phase (the tool handles it internally, just call it and wait) — required for any phase that says to use it. 'advance' moves to the next phase (blocked until run_phase completes for delegated phases)." }),
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

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const sessionId = getSessionId(ctx as any);
			const workflows = getWorkflows();

			switch (params.action) {
				case "list": {
					const list = Array.from(workflows.values()).map((w) => ({
						id: w.id,
						name: w.name,
						description: w.description,
						phases: w.phases.length,
					}));
					if (list.length === 0) {
						return {
							content: [{ type: "text", text: "No workflows available. The server may not have exported definitions yet.\n" + `Expected file: ${DEFINITIONS_PATH}` }],
							details: undefined,
						};
					}
					return {
						content: [{ type: "text", text: JSON.stringify({ workflows: list }, null, 2) }],
						details: undefined,
					};
				}

				case "start": {
					if (!params.workflow_id) {
						return { content: [{ type: "text", text: "Error: workflow_id is required for 'start'" }], details: undefined };
					}
					const wf = workflows.get(params.workflow_id);
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
					const phaseList = wf.phases.map((p) => p.name).join(" → ");
					const execNote = formatPhaseExecNote(phase);
					return {
						content: [{
							type: "text",
							text: `Workflow "${wf.name}" started.\n\nPhases: ${phaseList}\n\n` +
								`## Current Phase: ${phase.name} (1/${wf.phases.length})\n\n` +
								`${phase.instructions}\n\n**Exit criteria:** ${phase.exitCriteria}${execNote}`,
						}],
						details: undefined,
					};
				}

				case "status": {
					const state = loadState(sessionId);
					if (!state) {
						return { content: [{ type: "text", text: "No active workflow. Use action 'start' to begin one." }], details: undefined };
					}
					const wf = workflows.get(state.workflowId);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Workflow definition '${state.workflowId}' not found. Server may need to re-export definitions.` }], details: undefined };
					}

					const phase = wf.phases[state.currentPhaseIndex];
					const execDesc = phase ? describeExecution(phase) : "inline";
					const lines = [
						`## Workflow: ${wf.name}`,
						`**Status:** ${state.status}`,
						`**Phase:** ${phase?.name || "done"} (${state.currentPhaseIndex + 1}/${wf.phases.length})`,
						`**Execution:** ${execDesc}`,
						"",
					];
					if (phase && state.status === "running") {
						lines.push(`### Instructions`, "", phase.instructions, "", `**Exit criteria:** ${phase.exitCriteria}`, "");
						const execNote = formatPhaseExecNote(phase);
						if (execNote) lines.push(execNote, "");
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
					lines.push("", `### Report`, `Report URL: /api/sessions/${sessionId}/workflow/report`);

					return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
				}

				case "run_phase": {
					// Execute the current phase as sub-agent(s) with isolated context
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					const wf = workflows.get(state.workflowId);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Workflow definition '${state.workflowId}' not found.` }], details: undefined };
					}
					const phase = wf.phases[state.currentPhaseIndex];
					if (!phase) {
						return { content: [{ type: "text", text: "Error: No current phase." }], details: undefined };
					}

					if (!isSubAgentPhase(phase)) {
						return { content: [{ type: "text", text: "This phase is inline — execute it directly, don't use run_phase." }], details: undefined };
					}

					const cwd = (ctx as any).cwd || process.cwd();
					const parentSessionId = getParentSessionId(ctx);
					const lines: string[] = [];
					const delegateEntries: Array<{ id: string; sessionId: string; name: string; status: string; durationMs: number }> = [];

					if (isParallelGroup(phase) && phase.parallelPhases!.length > 0) {
						const subPhases = phase.parallelPhases!;
						lines.push(`Running ${subPhases.length} delegates in parallel...`);
						lines.push(`Phases: ${subPhases.map((p) => p.name).join(", ")}`);
						lines.push("");

						const completedResults: (DelegateResult & { phaseId: string })[] = [];
						const phaseStartTime = Date.now();
						// Track session IDs as they're created (before completion)
						const sessionIds: string[] = new Array(subPhases.length).fill("");

						// Helper: build current progress snapshot
						function buildPhaseProgress() {
							return {
								content: [{ type: "text" as const, text: `${completedResults.length}/${subPhases.length} finished.` }],
								details: {
									delegates: subPhases.map((p, i) => {
										const cr = completedResults.find((r) => r.phaseId === p.id);
										if (cr) return { id: cr.id, sessionId: cr.sessionId, name: p.name, status: cr.status, durationMs: cr.durationMs };
										return { id: sessionIds[i]?.slice(0, 12) || "?", sessionId: sessionIds[i] || "", name: p.name, status: sessionIds[i] ? "running" : "starting", durationMs: Date.now() - phaseStartTime };
									}),
								},
							};
						}

						// Emit initial progress
						if (onUpdate) onUpdate(buildPhaseProgress());

						// Step 1: Create all delegate sessions (get IDs immediately)
						for (let i = 0; i < subPhases.length; i++) {
							try {
								const instructions = buildPhaseInstructions(subPhases[i], state.context);
								const sid = await createDelegateSession(parentSessionId, instructions, cwd, {
									title: `⚡ ${subPhases[i].name}`,
									context: state.context,
								});
								sessionIds[i] = sid;
								if (onUpdate) onUpdate(buildPhaseProgress());
							} catch (err: any) {
								completedResults.push({
									id: "error", sessionId: "", status: "failed", output: "",
									durationMs: Date.now() - phaseStartTime, error: err.message, phaseId: subPhases[i].id,
								});
								if (onUpdate) onUpdate(buildPhaseProgress());
							}
						}

						// Heartbeat: re-emit state every 3s for reconnecting clients
						const phaseHeartbeat = setInterval(() => {
							if (onUpdate && completedResults.length < subPhases.length) {
								onUpdate(buildPhaseProgress());
							}
						}, 3000);

						// Step 2: Wait for all delegate sessions in parallel
						const promises = sessionIds.map((sid, i) => {
							if (!sid) return Promise.resolve(); // already failed during creation
							const timeoutMs = subPhases[i].timeoutMs ?? 600_000;
							return waitForDelegate(sid, timeoutMs, signal).then((result) => {
								completedResults.push({
									id: sid.slice(0, 12), sessionId: sid,
									status: result.status as DelegateResult["status"],
									output: result.output, durationMs: Date.now() - phaseStartTime,
									phaseId: subPhases[i].id,
								});
								if (onUpdate) onUpdate(buildPhaseProgress());
							}).catch((err: any) => {
								completedResults.push({
									id: sid.slice(0, 12), sessionId: sid,
									status: "failed", output: "", durationMs: Date.now() - phaseStartTime,
									error: err.message, phaseId: subPhases[i].id,
								});
								if (onUpdate) onUpdate(buildPhaseProgress());
							});
						});

						await Promise.all(promises);
						clearInterval(phaseHeartbeat);
						const results = completedResults;

						for (const result of results) {
							const statusIc = result.status === "completed" ? "✓" : result.status === "timeout" ? "⏱" : "✗";
							const sp = subPhases.find((p) => p.id === result.phaseId);
							lines.push(`### ${statusIc} ${sp?.name || result.phaseId} (${result.status}, ${Math.round(result.durationMs / 1000)}s)`);
							if (result.error) lines.push(`**Error:** ${result.error}`);
							if (result.output) {
								const artifactName = `delegate-${result.phaseId}.txt`;
								const filePath = storeArtifactFile(sessionId, artifactName, result.output);
								state.artifacts.push({ name: artifactName, filePath, mimeType: "text/plain", collectedAt: Date.now(), phaseId: phase.id });
								lines.push(`Output collected as artifact: ${artifactName}`);
								const excerpt = result.output.length > 500 ? result.output.slice(0, 500) + "..." : result.output;
								lines.push("```\n" + excerpt + "\n```");
							}
							lines.push("");
							delegateEntries.push({ id: result.id, sessionId: result.sessionId, name: sp?.name || result.phaseId, status: result.status, durationMs: result.durationMs });
						}

						const failedCount = results.filter((r) => r.status !== "completed").length;
						lines.push(`**Summary:** ${results.length - failedCount}/${results.length} delegates completed successfully.`);
						if (failedCount > 0) lines.push(`**Warning:** ${failedCount} delegate(s) failed or timed out.`);

						saveState(state);

					} else if (phase.subAgent) {
						lines.push(`Running delegate for phase "${phase.name}"...`);
						lines.push("");

						// Create session first to get ID for the link
						const instructions = buildPhaseInstructions(phase, state.context);
						const timeoutMs = phase.timeoutMs ?? 600_000;
						let singleSessionId = "";
						try {
							singleSessionId = await createDelegateSession(parentSessionId, instructions, cwd, {
								title: `⚡ ${phase.name}`,
								context: state.context,
							});
						} catch (err: any) {
							// Session creation failed
						}

						if (onUpdate) {
							onUpdate({ content: [{ type: "text", text: lines.join("\n") }], details: { delegates: [{ id: singleSessionId?.slice(0, 12) || "?", sessionId: singleSessionId, name: phase.name, status: singleSessionId ? "running" : "failed", durationMs: 0 }] } });
						}

						let result: DelegateResult & { phaseId: string };
						if (singleSessionId) {
							const startTime = Date.now();
							const waitResult = await waitForDelegate(singleSessionId, timeoutMs, signal);
							result = {
								id: singleSessionId.slice(0, 12), sessionId: singleSessionId,
								status: waitResult.status as DelegateResult["status"],
								output: waitResult.output, durationMs: Date.now() - startTime, phaseId: phase.id,
							};
						} else {
							result = { id: "error", sessionId: "", status: "failed", output: "", durationMs: 0, error: "Session creation failed", phaseId: phase.id };
						}

						const statusIc = result.status === "completed" ? "✓" : result.status === "timeout" ? "⏱" : "✗";
						lines.push(`### ${statusIc} ${result.phaseId} (${result.status}, ${Math.round(result.durationMs / 1000)}s)`);
						if (result.error) lines.push(`**Error:** ${result.error}`);
						if (result.output) {
							const artifactName = `delegate-${result.phaseId}.txt`;
							const filePath = storeArtifactFile(sessionId, artifactName, result.output);
							state.artifacts.push({ name: artifactName, filePath, mimeType: "text/plain", collectedAt: Date.now(), phaseId: phase.id });
							lines.push(`Output collected as artifact: ${artifactName}`);
						}

						delegateEntries.push({ id: result.id, sessionId: result.sessionId, name: phase.name, status: result.status, durationMs: result.durationMs });
						saveState(state);
					}

					// Mark that run_phase was executed for this phase
					const runPhaseRec = state.phaseHistory.find(
						(r) => r.phaseId === phase.id && r.status === "active",
					);
					if (runPhaseRec) runPhaseRec.ranRunPhase = true;
					saveState(state);

					lines.push("\nUse action 'advance' to move to the next phase.");
					return { content: [{ type: "text", text: lines.join("\n") }], details: { delegates: delegateEntries } };
				}

				case "advance": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow to advance." }], details: undefined };
					}
					const wf = workflows.get(state.workflowId);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Workflow definition '${state.workflowId}' not found.` }], details: undefined };
					}
					const now = Date.now();
					const currentPhase = wf.phases[state.currentPhaseIndex];

					// Enforce: sub-agent/parallel phases MUST be executed via run_phase
					if (currentPhase && isSubAgentPhase(currentPhase)) {
						const activeRec = state.phaseHistory.find(
							(r) => r.phaseId === currentPhase.id && r.status === "active",
						);
						if (!activeRec?.ranRunPhase) {
							return {
								content: [{
									type: "text",
									text: `Error: Cannot advance past "${currentPhase.name}" — this is a delegated phase. ` +
										`You must call the workflow tool with action "run_phase" first. ` +
										`The tool handles execution internally; just call it and wait for it to return.`,
								}],
								details: undefined,
							};
						}
					}

					const activeRec = state.phaseHistory.find(
						(r) => r.phaseId === currentPhase?.id && r.status === "active",
					);
					if (activeRec) {
						activeRec.status = "completed";
						activeRec.completedAt = now;
					}

					state.currentPhaseIndex++;

					if (state.currentPhaseIndex >= wf.phases.length) {
						state.status = "completed";
						state.completedAt = now;
						saveState(state);
						return {
							content: [{
								type: "text",
								text: `All phases complete! Workflow "${wf.name}" finished.\n\nReport: /api/sessions/${sessionId}/workflow/report`,
							}],
							details: undefined,
						};
					}

					const prevPhase = wf.phases[state.currentPhaseIndex - 1];
					const nextPhase = wf.phases[state.currentPhaseIndex];
					state.phaseHistory.push({ phaseId: nextPhase.id, startedAt: now, status: "active" });
					saveState(state);

					const execNote = formatPhaseExecNote(nextPhase);
					return {
						content: [{
							type: "text",
							text: `Completed: ${prevPhase.name} | Next: ${nextPhase.name} (${state.currentPhaseIndex + 1}/${wf.phases.length})\n\n` +
								`## Current Phase: ${nextPhase.name} (${state.currentPhaseIndex + 1}/${wf.phases.length})\n\n` +
								`${nextPhase.instructions}\n\n**Exit criteria:** ${nextPhase.exitCriteria}${execNote}`,
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
					const wf = workflows.get(state.workflowId);
					if (!wf) {
						return { content: [{ type: "text", text: `Error: Workflow definition '${state.workflowId}' not found.` }], details: undefined };
					}
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
					const wf = workflows.get(state.workflowId);
					const mimeType = params.mime_type || "text/plain";
					const filePath = storeArtifactFile(sessionId, params.name, params.content);
					const currentPhaseId = wf?.phases[state.currentPhaseIndex]?.id;

					state.artifacts.push({
						name: params.name,
						filePath,
						mimeType,
						collectedAt: Date.now(),
						phaseId: currentPhaseId,
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
					const wf = workflows.get(state.workflowId);
					const now = Date.now();

					if (wf) {
						const activeRec = state.phaseHistory.find(
							(r) => r.phaseId === wf.phases[state.currentPhaseIndex]?.id && r.status === "active",
						);
						if (activeRec) {
							activeRec.status = "completed";
							activeRec.completedAt = now;
						}
					}

					state.status = "completed";
					state.completedAt = now;
					saveState(state);

					return {
						content: [{
							type: "text",
							text: `Workflow "${wf?.name || state.workflowId}" completed!\n\nReport: /api/sessions/${sessionId}/workflow/report`,
						}],
						details: undefined,
					};
				}

				case "fail": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					state.status = "failed";
					state.completedAt = Date.now();
					if (params.reason) state.context["failure_reason"] = params.reason;
					saveState(state);

					return {
						content: [{
							type: "text",
							text: `Workflow marked as failed.${params.reason ? ` Reason: ${params.reason}` : ""}\n\nReport: /api/sessions/${sessionId}/workflow/report`,
						}],
						details: undefined,
					};
				}

				case "cancel": {
					const state = loadState(sessionId);
					if (!state || state.status !== "running") {
						return { content: [{ type: "text", text: "Error: No running workflow." }], details: undefined };
					}
					state.status = "cancelled";
					state.completedAt = Date.now();
					saveState(state);

					return {
						content: [{ type: "text", text: `Workflow cancelled.` }],
						details: undefined,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}. Valid actions: list, start, status, advance, run_phase, reset, collect_artifact, set_context, complete, fail, cancel` }],
						details: undefined,
					};
			}
		},
	});
};

export default extension;
