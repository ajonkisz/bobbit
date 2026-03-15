/**
 * Sub-agent runner for the workflow extension.
 *
 * Spawns independent agent processes with isolated context.
 * Used by the workflow tool to execute "sub-agent" and "parallel-group" phases.
 *
 * Each sub-agent:
 * - Gets a fresh system prompt with only phase instructions + project AGENTS.md
 * - Has no access to the parent session's conversation
 * - Runs to completion (agent_end event) or times out
 * - Conversation output is captured for the parent to process
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const PROMPTS_DIR = path.join(os.homedir(), ".pi", "session-prompts");
const ARTIFACTS_DIR = path.join(os.homedir(), ".pi", "workflow-artifacts");

export interface SubAgentPhase {
	id: string;
	name: string;
	instructions: string;
	exitCriteria: string;
	timeoutMs?: number;
}

export interface SubAgentResult {
	phaseId: string;
	status: "completed" | "failed" | "timeout";
	/** Readable text extracted from the sub-agent's conversation */
	output: string;
	durationMs: number;
	error?: string;
}

/**
 * Build a system prompt file for a sub-agent.
 * Includes AGENTS.md from cwd for project context, plus phase instructions.
 */
function writeSubAgentPrompt(
	subId: string,
	phase: SubAgentPhase,
	context: Record<string, string>,
	cwd: string,
): string {
	const sections: string[] = [];

	// Include AGENTS.md if present
	const agentsPath = path.join(cwd, "AGENTS.md");
	if (fs.existsSync(agentsPath)) {
		try {
			const agentsMd = fs.readFileSync(agentsPath, "utf-8").trim();
			if (agentsMd) {
				sections.push("# Project Context\n\n" + agentsMd);
			}
		} catch { /* ignore */ }
	}

	// Phase instructions as a goal
	sections.push(`# Goal\n\n**Workflow Phase: ${phase.name}** (Status: active)`);
	sections.push(phase.instructions);
	sections.push(`\n**Exit criteria:** ${phase.exitCriteria}`);

	if (Object.keys(context).length > 0) {
		sections.push("\n## Workflow Context");
		for (const [key, value] of Object.entries(context)) {
			sections.push(`- **${key}**: ${value}`);
		}
	}

	sections.push("\n## Instructions");
	sections.push("- Complete this phase and then stop.");
	sections.push("- Use the workflow tool to collect artifacts and set context values as needed.");
	sections.push("- When finished, use the workflow tool with action 'complete'.");

	fs.mkdirSync(PROMPTS_DIR, { recursive: true });
	const promptPath = path.join(PROMPTS_DIR, `${subId}.md`);
	fs.writeFileSync(promptPath, sections.join("\n\n") + "\n", "utf-8");
	return promptPath;
}

/**
 * Find the pi-coding-agent CLI path.
 */
function findAgentCli(): string {
	// Try the same resolution the server uses
	try {
		const mainPath = require.resolve("@mariozechner/pi-coding-agent");
		return path.join(path.dirname(mainPath), "cli.js");
	} catch { /* ignore */ }

	// Try import.meta.resolve style paths
	const candidates = [
		path.join(os.homedir(), "w", "bobbit", "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
		path.join(process.cwd(), "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}

	throw new Error("Could not find pi-coding-agent CLI");
}

/**
 * Run a single sub-agent for a workflow phase.
 *
 * Spawns a new agent process in RPC mode, sends a kickoff prompt,
 * waits for agent_end, and captures the conversation.
 */
export async function runSubAgent(
	phase: SubAgentPhase,
	context: Record<string, string>,
	cwd: string,
): Promise<SubAgentResult> {
	const startTime = Date.now();
	const subId = `sub-${phase.id}-${randomUUID().slice(0, 8)}`;
	const timeoutMs = phase.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const promptPath = writeSubAgentPrompt(subId, phase, context, cwd);
	const cliPath = findAgentCli();

	const args = ["node", cliPath, "--mode", "rpc", "--cwd", cwd, "--system-prompt", promptPath];

	return new Promise<SubAgentResult>((resolve) => {
		const proc = spawn(args[0], args.slice(1), {
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
				resolve({
					phaseId: phase.id,
					status: "timeout",
					output,
					durationMs: Date.now() - startTime,
					error: `Timed out after ${timeoutMs}ms`,
				});
			}
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timer);
			try {
				if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
			} catch { /* ignore */ }
		}

		function handleLine(line: string) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) return;

			let parsed: any;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				return; // skip non-JSON
			}

			// Capture assistant text for output
			if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
				const content = parsed.message.content;
				const text = Array.isArray(content)
					? content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: typeof content === "string" ? content : "";
				if (text) {
					if (output) output += "\n\n";
					output += text;
				}
			}

			// Handle responses to our commands
			if (parsed.type === "response" && parsed.id === "prompt_1") {
				// Prompt acknowledged — agent is running
			}

			// Agent finished
			if (parsed.type === "agent_end" && !settled) {
				settled = true;
				// Give a moment for any final output, then resolve
				setTimeout(() => {
					proc.kill("SIGTERM");
					cleanup();
					resolve({
						phaseId: phase.id,
						status: "completed",
						output,
						durationMs: Date.now() - startTime,
					});
				}, 500);
			}
		}

		proc.stdout!.on("data", (chunk: Buffer) => {
			lineBuffer += chunk.toString("utf-8");
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop()!;
			for (const line of lines) handleLine(line);
		});

		proc.stderr!.on("data", () => {
			// Suppress stderr — sub-agent debug output
		});

		proc.on("exit", (code) => {
			if (!settled) {
				settled = true;
				cleanup();
				if (code !== 0 && code !== null) {
					resolve({
						phaseId: phase.id,
						status: "failed",
						output,
						durationMs: Date.now() - startTime,
						error: `Process exited with code ${code}`,
					});
				} else {
					resolve({
						phaseId: phase.id,
						status: "completed",
						output,
						durationMs: Date.now() - startTime,
					});
				}
			}
		});

		// Wait briefly for process to initialize, then send prompt
		setTimeout(() => {
			if (proc.stdin && !settled) {
				const cmd = JSON.stringify({
					type: "prompt",
					id: "prompt_1",
					message: `Execute the workflow phase "${phase.name}". Follow the instructions in your system prompt carefully.`,
				});
				proc.stdin.write(cmd + "\n");
			}
		}, 500);
	});
}

/**
 * Run multiple phases in parallel as independent sub-agents.
 * Returns results in the same order as the input phases.
 */
export async function runSubAgentsParallel(
	phases: SubAgentPhase[],
	context: Record<string, string>,
	cwd: string,
): Promise<SubAgentResult[]> {
	return Promise.all(phases.map((phase) => runSubAgent(phase, context, cwd)));
}
