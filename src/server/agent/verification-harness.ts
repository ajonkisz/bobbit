import { exec, execSync } from "node:child_process";
import path from "node:path";
import type { GateStore, GateSignal } from "./gate-store.js";
import type { WorkflowGate, Workflow } from "./workflow-store.js";

/** Resolve Git Bash on Windows — avoids WSL's bash which `shell: "bash"` may pick up. */
function resolveShell(): string {
	if (process.platform !== "win32") return "/bin/sh";
	try {
		const gitExe = execSync("where.exe git", { encoding: "utf-8" }).split("\n")[0].trim();
		let dir = path.dirname(gitExe);
		for (let i = 0; i < 4; i++) {
			const candidate = path.join(dir, "usr", "bin", "bash.exe");
			try { execSync(`"${candidate}" --version`, { stdio: "ignore" }); return candidate; } catch {}
			dir = path.dirname(dir);
		}
	} catch {}
	return "bash";
}

const SHELL = resolveShell();

export class VerificationHarness {
	constructor(
		private gateStore: GateStore,
		private broadcastFn: (goalId: string, event: any) => void,
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
					// llm-review — auto-pass with warning
					console.warn(`[verification] LLM review step "${step.name}" auto-passed — not yet implemented`);
					result = { passed: true, output: "⚠ LLM review not yet implemented — auto-passed." };
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
			exec(command, { cwd, timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024, shell: SHELL }, (error, stdout, stderr) => {
				const output = (stdout + "\n" + stderr).trim().slice(-5000);
				const exitedNonZero = !!error;

				if (expectFailure) {
					// expect: failure — non-zero exit = pass, zero exit = fail
					resolve({ passed: exitedNonZero, output: output || (error?.message ?? "") });
				} else {
					// expect: success (default) — zero exit = pass
					resolve({ passed: !exitedNonZero, output: output || (error?.message ?? "") });
				}
			});
		});
	}
}
