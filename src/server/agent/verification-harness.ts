import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { statSync } from "node:fs";
import path from "node:path";
import { piDir } from "../pi-dir.js";
import type { GateStore, GateSignal } from "./gate-store.js";
import type { RoleStore } from "./role-store.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import type { WorkflowGate, Workflow } from "./workflow-store.js";

/** Resolve Git Bash path on Windows for commands needing Unix tools. */
function findGitBash(): string | null {
	if (process.platform !== "win32") return null;
	const candidates = [
		"C:/Program Files/Git/bin/bash.exe",
		"C:/Program Files/Git/usr/bin/bash.exe",
		"C:/Program Files (x86)/Git/bin/bash.exe",
	];
	try {
		const gitExe = execSync("where.exe git", { encoding: "utf-8", shell: process.env.ComSpec || "cmd.exe" }).split("\n")[0].trim();
		if (gitExe) {
			let dir = path.dirname(gitExe);
			for (let i = 0; i < 4; i++) {
				candidates.unshift(path.join(dir, "bin", "bash.exe").replace(/\\/g, "/"));
				candidates.unshift(path.join(dir, "usr", "bin", "bash.exe").replace(/\\/g, "/"));
				dir = path.dirname(dir);
			}
		}
	} catch {}
	for (const c of candidates) {
		try { statSync(c); return c; } catch {}
	}
	return null;
}

const GIT_BASH = findGitBash();

/** Extract pass/fail verdict from sub-agent output. Exported for unit testing. */
export function parseVerdict(output: string): boolean | null {
	const match = output.match(/<verdict>\s*(pass|fail)\s*<\/verdict>/i);
	if (!match) return null;
	return match[1].toLowerCase() === "pass";
}

export class VerificationHarness {
	constructor(
		private gateStore: GateStore,
		private broadcastFn: (goalId: string, event: any) => void,
		private roleStore: RoleStore,
	) {}

	/**
	 * Verify a gate signal asynchronously (fire-and-forget from caller).
	 * Updates signal verification results and gate status when done.
	 */
	async verifyGateSignal(
		signal: GateSignal,
		gate: WorkflowGate,
		cwd: string,
		goalBranch?: string,
		primaryBranch?: string,
		allGateStates?: Map<string, { metadata?: Record<string, string> }>,
	): Promise<void> {
		const steps = gate.verify;
		if (!steps || steps.length === 0) {
			// No verification — auto-pass
			this.gateStore.updateSignalVerification(signal.id, { status: "passed", steps: [] });
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, "passed");
			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status: "passed",
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status: "passed",
			});
			return;
		}

		// Broadcast verification started
		this.broadcastFn(signal.goalId, {
			type: "gate_verification_started",
			goalId: signal.goalId,
			gateId: signal.gateId,
			signalId: signal.id,
		});

		try {
			const builtinVars: Record<string, string> = {
				branch: goalBranch || "HEAD",
				master: primaryBranch || "master",
				cwd,
			};

			// Also include the current signal's metadata as bare variables
			if (signal.metadata) {
				for (const [k, v] of Object.entries(signal.metadata)) {
					builtinVars[k] = v;
				}
			}

			const results: GateSignal["verification"]["steps"] = [];

			for (const step of steps) {
				let result: { passed: boolean; output: string };
				const startTime = Date.now();

				if (step.type === "command") {
					const cmd = this.substituteVars(step.run || "", builtinVars, allGateStates);
					const expectFailure = step.expect === "failure";
					result = await this.runCommandStep(cmd, cwd, step.timeout || 300, expectFailure);
				} else {
					// llm-review — spawn a one-shot reviewer sub-agent
					const prompt = this.substituteVars(step.prompt || "", builtinVars, allGateStates);
					result = await this.runLlmReviewStep(
						{ name: step.name, prompt, timeout: step.timeout },
						cwd,
						builtinVars,
						signal.content,
						signal.metadata,
					);
				}

				const duration_ms = Date.now() - startTime;
				results.push({
					name: step.name,
					type: step.type,
					passed: result.passed,
					output: result.output,
					duration_ms,
					expect: step.expect,
				});

				if (!result.passed) break; // Stop on first failure
			}

			const allPassed = results.every(r => r.passed);
			const status = allPassed ? "passed" : "failed";

			this.gateStore.updateSignalVerification(signal.id, { status, steps: results });
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, status);

			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status,
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status,
			});
		} catch (err: any) {
			this.gateStore.updateSignalVerification(signal.id, {
				status: "failed",
				steps: [{ name: "Error", type: "command", passed: false, output: err.message, duration_ms: 0 }],
			});
			this.gateStore.updateGateStatus(signal.goalId, signal.gateId, "failed");

			this.broadcastFn(signal.goalId, {
				type: "gate_verification_complete",
				goalId: signal.goalId,
				gateId: signal.gateId,
				signalId: signal.id,
				status: "failed",
			});
			this.broadcastFn(signal.goalId, {
				type: "gate_status_changed",
				goalId: signal.goalId,
				gateId: signal.gateId,
				status: "failed",
			});
		}
	}

	/**
	 * Spawn a one-shot reviewer sub-agent to perform an LLM-powered code review.
	 * Follows the pattern from src/server/skills/sub-agent.ts.
	 */
	private async runLlmReviewStep(
		step: { name: string; prompt?: string; timeout?: number },
		cwd: string,
		builtinVars: Record<string, string>,
		signalContent?: string,
		signalMetadata?: Record<string, string>,
	): Promise<{ passed: boolean; output: string }> {
		const role = this.roleStore.get("reviewer");
		if (!role) {
			return { passed: false, output: "LLM review failed: 'reviewer' role not found in role store." };
		}

		const subSessionId = `llm-review-${randomUUID().slice(0, 12)}`;
		const timeoutMs = (step.timeout || 300) * 1000;

		// Build system prompt from reviewer role template + step prompt + signal context
		let rolePrompt = role.promptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, builtinVars.branch || "HEAD")
			.replace(/\{\{AGENT_ID\}\}/g, subSessionId);

		const sections: string[] = [rolePrompt];

		if (step.prompt) {
			sections.push(`\n## Review Step Instructions\n\n${step.prompt}`);
		}

		// Signal context
		const contextLines: string[] = [
			"\n## Signal Context",
			`- Branch: ${builtinVars.branch || "HEAD"}`,
			`- Primary branch: ${builtinVars.master || "master"}`,
			`- Working directory: ${cwd}`,
		];
		if (signalContent) {
			contextLines.push(`\n### Signal Content\n${signalContent}`);
		}
		if (signalMetadata && Object.keys(signalMetadata).length > 0) {
			contextLines.push("\n### Signal Metadata");
			for (const [k, v] of Object.entries(signalMetadata)) {
				contextLines.push(`- **${k}**: ${v}`);
			}
		}
		sections.push(contextLines.join("\n"));

		const combinedPrompt = sections.join("\n");

		// Assemble system prompt to temp file
		const systemPromptPath = assembleSystemPrompt(subSessionId, {
			cwd,
			goalSpec: combinedPrompt,
			goalTitle: `LLM Review: ${step.name}`,
			goalState: "active",
		});

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: ["--tools", role.allowedTools.join(",")],
		};
		if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

		const rpc = new RpcBridge(bridgeOptions);

		try {
			await rpc.start();

			// Wait for agent_end event with timeout
			const completionPromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`LLM review sub-agent timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs);

				const eventUnsub = rpc.onEvent((event: any) => {
					if (event.type === "agent_end") {
						clearTimeout(timer);
						eventUnsub();
						resolve();
					}
				});
			});

			// Send kickoff prompt
			const kickoff = [
				`Perform a code review for the gate verification step: "${step.name}".`,
				"",
				step.prompt || "",
				"",
				"## Required Output Format",
				"You MUST produce your review in this exact format:",
				"",
				"<review>",
				`# Code Review: ${step.name}`,
				"",
				"## Summary",
				"...",
				"",
				"## Findings",
				"[critical] file.ts:line — Description",
				"[high] file.ts:line — Description",
				"[medium] file.ts:line — Description",
				"[low] file.ts:line — Description",
				"",
				"## Verdict",
				"...",
				"",
				"<verdict>pass</verdict> or <verdict>fail</verdict>",
				"</review>",
				"",
				"Rules:",
				"- Use <verdict>fail</verdict> if any critical or high severity findings exist",
				"- Use <verdict>pass</verdict> if no critical or high severity findings",
				"- You MUST include exactly one <verdict> tag",
			].join("\n");

			await rpc.prompt(kickoff);
			await completionPromise;

			// Extract last assistant message
			let output = "";
			try {
				const msgsResp = await rpc.getMessages();
				if (msgsResp.success && Array.isArray(msgsResp.data)) {
					output = extractLastAssistantOutput(msgsResp.data);
				}
			} catch {
				// Non-fatal — we may still have partial output
			}

			const verdict = parseVerdict(output);
			if (verdict === null) {
				return { passed: false, output: output || "LLM review failed: no <verdict> tag found in sub-agent output." };
			}

			return { passed: verdict, output };
		} catch (err: any) {
			const isTimeout = err.message?.includes("timed out");
			const errOutput = isTimeout
				? `LLM review timed out after ${(timeoutMs / 1000)}s.`
				: `LLM review failed: ${err.message}`;
			return { passed: false, output: errOutput };
		} finally {
			await rpc.stop().catch(() => {});
			// Clean up temporary system prompt
			try {
				const promptDir = path.join(piDir(), "session-prompts");
				const promptFile = path.join(promptDir, `${subSessionId}.md`);
				if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
			} catch { /* ignore */ }
		}
	}

	/**
	 * Substitute variables in a template string.
	 * Supports: {{var}}, {{gate_id.field}} (for upstream gate metadata)
	 */
	private substituteVars(
		template: string,
		builtinVars: Record<string, string>,
		allGateStates?: Map<string, { metadata?: Record<string, string> }>,
	): string {
		return template.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
			const trimmed = key.trim();

			// Check builtin vars first
			if (trimmed in builtinVars) return builtinVars[trimmed];

			// Check for gate_id.field syntax
			const dotIndex = trimmed.indexOf(".");
			if (dotIndex > 0 && allGateStates) {
				const gateId = trimmed.slice(0, dotIndex);
				const field = trimmed.slice(dotIndex + 1);
				const gateState = allGateStates.get(gateId);
				if (gateState?.metadata && field in gateState.metadata) {
					return gateState.metadata[field];
				}
			}

			return match; // Leave unresolved
		});
	}

	private runCommandStep(
		command: string,
		cwd: string,
		timeoutSec: number,
		expectFailure: boolean,
	): Promise<{ passed: boolean; output: string }> {
		return new Promise((resolve) => {
			const normalizedCwd = cwd.replace(/\\/g, "/");
			// On Windows, use cmd.exe for npm/node commands, Git Bash for commands with Unix tools (grep, etc.)
			const needsUnixShell = /\b(grep|awk|sed|cat|head|tail|wc|sort|uniq|xargs|find\s)\b/.test(command);
			let child;
			if (process.platform === "win32" && needsUnixShell && GIT_BASH) {
				child = spawn(GIT_BASH, ["--login", "-c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else if (process.platform === "win32") {
				const shell = process.env.ComSpec || "cmd.exe";
				child = spawn(shell, ["/d", "/s", "/c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
			} else {
				child = spawn("/bin/sh", ["-c", command], {
					cwd: normalizedCwd,
					timeout: timeoutSec * 1000,
					stdio: ["ignore", "pipe", "pipe"],
				});
			}
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024); });
			child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024); });
			child.on("close", (code) => {
				const output = (stdout + "\n" + stderr).trim().slice(-5000);
				const exitedNonZero = code !== 0;
				if (expectFailure) {
					resolve({ passed: exitedNonZero, output: output || `exit code ${code}` });
				} else {
					resolve({ passed: !exitedNonZero, output: output || `exit code ${code}` });
				}
			});
			child.on("error", (err) => {
				resolve({ passed: expectFailure, output: err.message });
			});
		});
	}
}

/**
 * Extract the last assistant message text from agent messages.
 */
function extractLastAssistantOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;

		const text = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: typeof msg.content === "string" ? msg.content : "";

		if (text) return text;
	}
	return "";
}
