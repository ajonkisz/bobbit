/**
 * Delegate extension — spawn independent agent processes to perform tasks.
 *
 * Registers a `delegate` tool that the agent (or other extensions) can use to
 * run work in a separate agent process with a controlled system prompt.
 * The delegate agent has full tool access (bash, read, write, etc.) but gets
 * only the instructions you provide — it does NOT see the parent conversation.
 *
 * Used standalone for ad-hoc delegation, and internally by the workflow
 * extension for `run_phase` on delegated phases.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ──

export interface DelegateResult {
	id: string;
	status: "completed" | "failed" | "timeout";
	output: string;
	durationMs: number;
	error?: string;
}

/** Details passed to the UI renderer */
export interface DelegateDetails {
	delegates: Array<{
		id: string;
		instructions: string;
		status: string;
		durationMs: number;
	}>;
}

const LOGS_DIR = path.join(os.homedir(), ".pi", "delegate-logs");

export interface DelegateOptions {
	/** Task instructions for the delegate agent */
	instructions: string;
	/** Working directory (defaults to process.cwd()) */
	cwd?: string;
	/** Timeout in ms (default: 600_000 = 10 minutes) */
	timeoutMs?: number;
	/** Additional context key-values included in the delegate's prompt */
	context?: Record<string, string>;
	/**
	 * What context the delegate receives:
	 *   - "full" (default): AGENTS.md + instructions only
	 *   - "goal": AGENTS.md + instructions + goal spec from context
	 *   - "none": parent's full system prompt + instructions
	 */
	isolation?: "full" | "goal" | "none";
	/** Path to parent system prompt (used when isolation is "none") */
	parentSystemPromptPath?: string;
}

// ── Agent CLI resolution (cached) ──

let _cachedCliPath: string | undefined;

function findAgentCli(): string {
	if (_cachedCliPath) return _cachedCliPath;
	try {
		const mainPath = require.resolve("@mariozechner/pi-coding-agent");
		_cachedCliPath = path.join(path.dirname(mainPath), "cli.js");
		return _cachedCliPath;
	} catch { /* ignore */ }
	const candidates = [
		path.join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) {
			_cachedCliPath = c;
			return c;
		}
	}
	throw new Error("Could not find pi-coding-agent CLI. Is @mariozechner/pi-coding-agent installed?");
}

// ── Prompt building ──

function buildDelegatePrompt(id: string, options: DelegateOptions): string {
	const isolation = options.isolation || "full";
	const cwd = options.cwd || process.cwd();
	const sections: string[] = [];

	if (isolation === "none" && options.parentSystemPromptPath && fs.existsSync(options.parentSystemPromptPath)) {
		try {
			const parentPrompt = fs.readFileSync(options.parentSystemPromptPath, "utf-8").trim();
			if (parentPrompt) sections.push(parentPrompt);
		} catch { /* ignore */ }
	} else {
		const agentsPath = path.join(cwd, "AGENTS.md");
		if (fs.existsSync(agentsPath)) {
			try {
				const agentsMd = fs.readFileSync(agentsPath, "utf-8").trim();
				if (agentsMd) sections.push("# Project Context\n\n" + agentsMd);
			} catch { /* ignore */ }
		}

		if (isolation === "goal" && options.context?.spec) {
			sections.push("# Goal Spec\n\n" + options.context.spec);
		}
	}

	sections.push("# Task\n\n" + options.instructions);

	if (options.context && Object.keys(options.context).length > 0) {
		sections.push("\n## Context");
		for (const [key, value] of Object.entries(options.context)) {
			if (key === "spec" && isolation === "goal") continue;
			sections.push(`- **${key}**: ${value}`);
		}
	}

	const promptsDir = path.join(os.homedir(), ".pi", "session-prompts");
	fs.mkdirSync(promptsDir, { recursive: true });
	const promptPath = path.join(promptsDir, `delegate-${id}.md`);
	fs.writeFileSync(promptPath, sections.join("\n\n") + "\n", "utf-8");
	return promptPath;
}

// ── Core spawn function (exported for use by workflow extension) ──

export function runDelegate(options: DelegateOptions, preAssignedId?: string, signal?: AbortSignal): Promise<DelegateResult> {
	const startTime = Date.now();
	const id = preAssignedId || randomUUID().slice(0, 12);
	const timeoutMs = options.timeoutMs ?? 600_000;
	const cwd = options.cwd || process.cwd();

	// Check if already aborted before spawning
	if (signal?.aborted) {
		return Promise.resolve({ id, status: "failed", output: "", durationMs: 0, error: "Aborted before start" });
	}

	const promptPath = buildDelegatePrompt(id, options);

	let cliPath: string;
	try {
		cliPath = findAgentCli();
	} catch (err: any) {
		return Promise.resolve({ id, status: "failed", output: "", durationMs: 0, error: err.message });
	}

	// Set up log file — written incrementally so it's available while running
	fs.mkdirSync(LOGS_DIR, { recursive: true });
	const logPath = path.join(LOGS_DIR, `${id}.jsonl`);
	const logStream = fs.createWriteStream(logPath, { flags: "a" });

	return new Promise<DelegateResult>((resolve) => {
		const proc = spawn("node", [cliPath, "--mode", "rpc", "--cwd", cwd, "--system-prompt", promptPath], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
			env: { ...process.env },
		});

		let lineBuffer = "";
		let output = "";
		let settled = false;

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill("SIGKILL");
				cleanup();
				resolve({ id, status: "timeout", output, durationMs: Date.now() - startTime, error: `Timed out after ${timeoutMs}ms` });
			}
		}, timeoutMs);

		// Listen for abort signal (user pressed Escape/abort)
		const onAbort = () => {
			if (!settled) {
				settled = true;
				proc.kill("SIGTERM");
				setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }, 2000);
				cleanup();
				resolve({ id, status: "failed", output, durationMs: Date.now() - startTime, error: "Aborted by user" });
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			try { logStream.end(); } catch { /* ignore */ }
			try { if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath); } catch { /* ignore */ }
		}

		function handleLine(line: string) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) return;

			// Write every JSONL line to the log file
			logStream.write(trimmed + "\n");

			let parsed: any;
			try { parsed = JSON.parse(trimmed); } catch { return; }

			if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
				const content = parsed.message.content;
				const text = Array.isArray(content)
					? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: typeof content === "string" ? content : "";
				if (text) { if (output) output += "\n\n"; output += text; }
			}

			if (parsed.type === "agent_end" && !settled) {
				settled = true;
				setTimeout(() => { proc.kill("SIGTERM"); cleanup(); resolve({ id, status: "completed", output, durationMs: Date.now() - startTime }); }, 500);
			}
		}

		proc.stdout!.on("data", (chunk: Buffer) => {
			lineBuffer += chunk.toString("utf-8");
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop()!;
			for (const line of lines) handleLine(line);
		});

		proc.stderr!.on("data", () => { /* suppress */ });

		proc.on("error", (err) => {
			if (!settled) {
				settled = true;
				cleanup();
				resolve({ id, status: "failed", output: "", durationMs: Date.now() - startTime, error: `Spawn error: ${err.message}` });
			}
		});

		proc.on("exit", (code) => {
			if (!settled) {
				settled = true;
				cleanup();
				resolve({
					id,
					status: code !== 0 && code !== null ? "failed" : "completed",
					output,
					durationMs: Date.now() - startTime,
					error: code !== 0 && code !== null ? `Process exited with code ${code}` : undefined,
				});
			}
		});

		setTimeout(() => {
			if (proc.stdin && !settled) {
				proc.stdin.write(JSON.stringify({
					type: "prompt",
					id: `prompt_${id}`,
					message: "Execute the task described in your system prompt. Follow the instructions carefully.",
				}) + "\n");
			}
		}, 500);
	});
}

/** Run multiple delegates in parallel */
export function runDelegatesParallel(optionsList: DelegateOptions[]): Promise<DelegateResult[]> {
	return Promise.all(optionsList.map(runDelegate));
}

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Run a task in a separate agent process. The delegate agent has full tool access (bash, read, write, edit) " +
			"but receives only the instructions you provide — it does not see this conversation. " +
			"Use this when you need isolated execution, parallel work, or an independent perspective. " +
			"The tool blocks until the delegate finishes and returns its output.",
		promptSnippet:
			"delegate - Run a task in a separate agent process with isolated context. Blocks until complete.",
		promptGuidelines: [
			"Use delegate when a task benefits from isolated context (e.g., code review, independent analysis)",
			"The delegate agent has full tool access — it can read files, run commands, write code, etc.",
			"Provide clear, self-contained instructions — the delegate cannot see this conversation",
			"Use the 'parallel' parameter to run multiple delegates concurrently",
		],
		parameters: Type.Object({
			instructions: Type.String({ description: "Task instructions for the delegate agent. Be specific and self-contained." }),
			parallel: Type.Optional(Type.Array(
				Type.Object({
					instructions: Type.String({ description: "Instructions for this parallel delegate" }),
					context: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional context key-values" })),
				}),
				{ description: "Run multiple delegates in parallel instead. Each gets its own instructions." },
			)),
			context: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional context key-values passed to the delegate" })),
			timeout_minutes: Type.Optional(Type.Number({ description: "Timeout in minutes (default: 10)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = (ctx as any).cwd || process.cwd();
			const timeoutMs = (params.timeout_minutes ?? 10) * 60_000;

			if (params.parallel && params.parallel.length > 0) {
				const optionsList: DelegateOptions[] = params.parallel.map((p: any) => ({
					instructions: p.instructions,
					cwd,
					timeoutMs,
					context: { ...params.context, ...p.context },
					isolation: "full" as const,
				}));

				// Pre-generate IDs so we can show log links immediately
				const delegateIds = optionsList.map(() => randomUUID().slice(0, 12));
				const completedResults: DelegateResult[] = [];

				// Emit initial progress with all delegate IDs (running state)
				if (onUpdate) {
					onUpdate({
						content: [{ type: "text", text: `Delegating to ${optionsList.length} agents...` }],
						details: {
							delegates: optionsList.map((opts, i) => ({
								id: delegateIds[i],
								instructions: opts.instructions.split("\n")[0].slice(0, 100),
								status: "running",
								durationMs: 0,
							})),
						},
					});
				}

				const promises = optionsList.map((opts, i) =>
					runDelegate(opts, delegateIds[i], signal).then((r) => {
						completedResults.push(r);
						// Emit progress with mix of completed and running
						if (onUpdate) {
							const completedIds = new Set(completedResults.map((cr) => cr.id));
							onUpdate({
								content: [{ type: "text", text: `${completedResults.length}/${optionsList.length} delegates finished` }],
								details: {
									delegates: optionsList.map((_, j) => {
										const cr = completedResults.find((c) => c.id === delegateIds[j]);
										if (cr) return { id: cr.id, instructions: optionsList[j].instructions.split("\n")[0].slice(0, 100), status: cr.status, durationMs: cr.durationMs };
										return { id: delegateIds[j], instructions: optionsList[j].instructions.split("\n")[0].slice(0, 100), status: "running", durationMs: 0 };
									}),
								},
							});
						}
						return r;
					}),
				);

				const results = await Promise.all(promises);
				const lines: string[] = [];
				const details: DelegateDetails = { delegates: [] };
				let failCount = 0;
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const ic = r.status === "completed" ? "✓" : r.status === "timeout" ? "⏱" : "✗";
					lines.push(`### ${ic} Delegate ${i + 1} (${r.status}, ${Math.round(r.durationMs / 1000)}s)`);
					if (r.error) lines.push(`**Error:** ${r.error}`);
					if (r.output) {
						const truncated = r.output.length > 3000 ? r.output.slice(0, 3000) + "\n...(truncated)" : r.output;
						lines.push("```\n" + truncated + "\n```");
					}
					lines.push("");
					if (r.status !== "completed") failCount++;
					details.delegates.push({
						id: r.id,
						instructions: optionsList[i].instructions.split("\n")[0].slice(0, 100),
						status: r.status,
						durationMs: r.durationMs,
					});
				}
				lines.push(`**Summary:** ${results.length - failCount}/${results.length} delegates completed.`);

				return { content: [{ type: "text", text: lines.join("\n") }], details };
			}

			// Single delegate
			const result = await runDelegate({
				instructions: params.instructions,
				cwd,
				timeoutMs,
				context: params.context,
				isolation: "full",
			}, undefined, signal);

			const lines: string[] = [];
			lines.push(`**Status:** ${result.status} (${Math.round(result.durationMs / 1000)}s)`);
			if (result.error) lines.push(`**Error:** ${result.error}`);
			if (result.output) {
				const truncated = result.output.length > 5000 ? result.output.slice(0, 5000) + "\n...(truncated)" : result.output;
				lines.push("", truncated);
			}

			const details: DelegateDetails = {
				delegates: [{
					id: result.id,
					instructions: params.instructions.split("\n")[0].slice(0, 100),
					status: result.status,
					durationMs: result.durationMs,
				}],
			};

			return { content: [{ type: "text", text: lines.join("\n") }], details };
		},
	});
};

export default extension;
