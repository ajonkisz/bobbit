import { exec } from "node:child_process";
import type { GoalArtifactStore, GoalArtifact } from "./goal-artifact-store.js";
import type { WorkflowArtifact, VerificationConfig, Workflow } from "./workflow-store.js";

export class VerificationHarness {
	constructor(
		private goalArtifactStore: GoalArtifactStore,
		private broadcastFn: (goalId: string, event: any) => void,
	) {}

	/**
	 * Run verification async (fire-and-forget from caller).
	 * Updates artifact status and broadcasts result when done.
	 */
	async verify(
		artifactId: string,
		goalArtifact: GoalArtifact,
		workflowArtifact: WorkflowArtifact,
		cwd: string,
		goalBranch?: string,
		primaryBranch?: string,
		workflow?: Workflow,
	): Promise<void> {
		const verification = workflowArtifact.verification;
		if (!verification) {
			// No verification config → auto-accept
			this.goalArtifactStore.update(artifactId, { status: "accepted" });
			this.broadcastFn(goalArtifact.goalId, {
				type: "artifact_verification_complete",
				goalId: goalArtifact.goalId,
				artifactId,
				status: "accepted",
			});
			return;
		}

		try {
			const steps = this.resolveSteps(verification);
			const vars = this.buildVars(goalArtifact, cwd, goalBranch, primaryBranch);
			const results: Array<{ name: string; type: string; passed: boolean; output: string }> = [];

			for (const step of steps) {
				let result: { passed: boolean; output: string };
				if (step.type === "command") {
					const cmd = this.substituteVars(step.command || "", vars);
					result = await this.runCommandStep(cmd, cwd, step.timeout);
				} else {
					// llm-review — auto-pass with warning (full LLM review is a future enhancement)
					console.warn(`[verification] LLM review step "${step.name}" auto-passed — not yet implemented`);
					result = { passed: true, output: "⚠ LLM review not yet implemented — auto-passed. This artifact was NOT reviewed by an LLM." };
				}
				results.push({ name: step.name, type: step.type, passed: result.passed, output: result.output });
				if (!result.passed) break; // Stop on first failure
			}

			const allPassed = results.every((r) => r.passed);
			const status = allPassed ? "accepted" : "rejected";
			const rejectionReason = allPassed ? undefined : results.find((r) => !r.passed)?.output;

			this.goalArtifactStore.update(artifactId, {
				status,
				verificationResult: { steps: results },
				rejectionReason,
			});

			this.broadcastFn(goalArtifact.goalId, {
				type: "artifact_verification_complete",
				goalId: goalArtifact.goalId,
				artifactId,
				status,
				verificationResult: { steps: results },
				rejectionReason,
			});

			// Cascade rejection to downstream artifacts
			if (status === "rejected" && workflow && workflowArtifact.id) {
				this.cascadeRejection(goalArtifact.goalId, workflowArtifact.id, workflow);
			}
		} catch (err: any) {
			this.goalArtifactStore.update(artifactId, {
				status: "rejected",
				rejectionReason: `Verification error: ${err.message}`,
			});
			this.broadcastFn(goalArtifact.goalId, {
				type: "artifact_verification_complete",
				goalId: goalArtifact.goalId,
				artifactId,
				status: "rejected",
				rejectionReason: `Verification error: ${err.message}`,
			});
		}
	}

	/**
	 * When an upstream artifact is rejected, cascade invalidation to downstream
	 * artifacts that depend on it. Downstream artifacts with "accepted" status
	 * are reset to "submitted" with a rejection reason noting the broken dependency.
	 */
	cascadeRejection(
		goalId: string,
		rejectedWorkflowArtifactId: string,
		workflow: Workflow,
	): void {
		// Find all workflow artifacts that depend (directly or transitively) on the rejected one
		const dependents = new Set<string>();
		const findDependents = (wfArtId: string) => {
			for (const art of workflow.artifacts) {
				if (art.dependsOn.includes(wfArtId) && !dependents.has(art.id)) {
					dependents.add(art.id);
					findDependents(art.id); // transitive
				}
			}
		};
		findDependents(rejectedWorkflowArtifactId);

		if (dependents.size === 0) return;

		const goalArtifacts = this.goalArtifactStore.getByGoalId(goalId);
		for (const ga of goalArtifacts) {
			if (ga.workflowArtifactId && dependents.has(ga.workflowArtifactId) && ga.status === "accepted") {
				const depName = workflow.artifacts.find(a => a.id === rejectedWorkflowArtifactId)?.name || rejectedWorkflowArtifactId;
				this.goalArtifactStore.update(ga.id, {
					status: "rejected",
					rejectionReason: `Dependency "${depName}" was re-verified and rejected. This artifact needs re-submission.`,
				});
				this.broadcastFn(goalId, {
					type: "artifact_verification_complete",
					goalId,
					artifactId: ga.id,
					status: "rejected",
					rejectionReason: `Dependency "${depName}" was rejected — downstream invalidated.`,
				});
			}
		}
	}

	private resolveSteps(config: VerificationConfig): Array<{ name: string; type: "command" | "llm-review"; command?: string; prompt?: string; timeout: number }> {
		if (config.steps && config.steps.length > 0) return config.steps;
		// Single-step configs (non-combined)
		if (config.type === "command") {
			return [{ name: "Command check", type: "command", command: config.command, timeout: config.timeout || 300 }];
		}
		if (config.type === "llm-review") {
			return [{ name: "LLM review", type: "llm-review", prompt: config.prompt, timeout: config.timeout || 600 }];
		}
		return [];
	}

	private buildVars(artifact: GoalArtifact, cwd: string, goalBranch?: string, primaryBranch?: string): Record<string, string> {
		return {
			command: artifact.content || "",
			branch: goalBranch || "HEAD",
			master: primaryBranch || "master",
			cwd,
		};
	}

	private substituteVars(template: string, vars: Record<string, string>): string {
		return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
	}

	private runCommandStep(command: string, cwd: string, timeoutSec: number): Promise<{ passed: boolean; output: string }> {
		return new Promise((resolve) => {
			exec(command, { cwd, timeout: timeoutSec * 1000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
				const output = (stdout + "\n" + stderr).trim().slice(-5000); // Keep last 5KB
				if (error) {
					resolve({ passed: false, output: output || error.message });
				} else {
					resolve({ passed: true, output });
				}
			});
		});
	}
}
