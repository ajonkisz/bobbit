import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getWorkflow } from "./registry.js";
import { storeArtifact } from "./artifact-store.js";
import { generateReport } from "./report.js";
import { synthesiseReviewFindings } from "./synthesis.js";
import type { Workflow, WorkflowState, WorkflowArtifact } from "./types.js";

const STATE_DIR = path.join(os.homedir(), ".pi", "workflow-state");

/**
 * Manages execution of a single workflow within a session.
 */
export class WorkflowRunner {
	private workflow: Workflow;
	private state: WorkflowState;
	private onChange?: (state: WorkflowState) => void;

	constructor(
		workflowId: string,
		sessionId: string,
		options?: { onChange?: (state: WorkflowState) => void },
	) {
		const workflow = getWorkflow(workflowId);
		if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
		this.workflow = workflow;
		this.onChange = options?.onChange;

		const now = Date.now();
		this.state = {
			workflowId,
			sessionId,
			status: "running",
			currentPhaseIndex: 0,
			phaseHistory: [
				{
					phaseId: workflow.phases[0].id,
					startedAt: now,
					status: "active",
				},
			],
			artifacts: [],
			startedAt: now,
			context: {},
		};
		this.persist();
	}

	/** Restore a runner from persisted state */
	static restore(
		sessionId: string,
		options?: { onChange?: (state: WorkflowState) => void },
	): WorkflowRunner | null {
		const filePath = path.join(STATE_DIR, `${sessionId}.json`);
		try {
			const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			const workflow = getWorkflow(data.workflowId);
			if (!workflow) return null;

			const runner = Object.create(WorkflowRunner.prototype) as WorkflowRunner;
			runner.workflow = workflow;
			runner.state = data;
			runner.onChange = options?.onChange;
			return runner;
		} catch {
			return null;
		}
	}

	getState(): WorkflowState {
		return { ...this.state };
	}

	getWorkflow(): Workflow {
		return this.workflow;
	}

	getCurrentPhase() {
		return this.workflow.phases[this.state.currentPhaseIndex];
	}

	/** Get the instructions for the current phase */
	getCurrentInstructions(): string {
		const phase = this.getCurrentPhase();
		if (!phase) return "";
		return [
			`## Workflow: ${this.workflow.name}`,
			`### Current Phase: ${phase.name} (${this.state.currentPhaseIndex + 1}/${this.workflow.phases.length})`,
			"",
			phase.instructions,
			"",
			`**Exit criteria:** ${phase.exitCriteria}`,
		].join("\n");
	}

	/** Advance to the next phase. Completes the current phase. */
	advancePhase(): boolean {
		if (this.state.status !== "running") return false;

		const now = Date.now();

		// Complete current phase
		const currentRecord = this.state.phaseHistory.find(
			(r) => r.phaseId === this.getCurrentPhase()?.id && r.status === "active",
		);
		if (currentRecord) {
			currentRecord.status = "completed";
			currentRecord.completedAt = now;
		}

		// Move to next
		this.state.currentPhaseIndex++;

		if (this.state.currentPhaseIndex >= this.workflow.phases.length) {
			// All phases done
			this.state.status = "completed";
			this.state.completedAt = now;
			this.generateAndStoreReport();
		} else {
			// Start next phase
			this.state.phaseHistory.push({
				phaseId: this.workflow.phases[this.state.currentPhaseIndex].id,
				startedAt: now,
				status: "active",
			});
		}

		this.persist();
		this.onChange?.(this.getState());
		return true;
	}

	/** Reset to an earlier phase, marking intervening phases */
	resetToPhase(phaseId: string, context?: string): boolean {
		if (this.state.status !== "running") return false;

		const targetIndex = this.workflow.phases.findIndex((p) => p.id === phaseId);
		if (targetIndex < 0 || targetIndex > this.state.currentPhaseIndex) return false;

		const now = Date.now();

		// Mark current phase as reset
		const currentRecord = this.state.phaseHistory.find(
			(r) => r.phaseId === this.getCurrentPhase()?.id && r.status === "active",
		);
		if (currentRecord) {
			currentRecord.status = "reset";
			currentRecord.completedAt = now;
		}

		// Move back
		this.state.currentPhaseIndex = targetIndex;
		this.state.phaseHistory.push({
			phaseId,
			startedAt: now,
			status: "active",
		});

		if (context) {
			this.state.context[`reset_${phaseId}_${now}`] = context;
		}

		this.persist();
		this.onChange?.(this.getState());
		return true;
	}

	/** Collect an artifact (stores to disk) */
	collectArtifact(
		name: string,
		content: string | Buffer,
		mimeType = "text/plain",
	): WorkflowArtifact {
		const filename = name.replace(/[^a-zA-Z0-9._-]/g, "_");
		const filePath = storeArtifact(this.state.sessionId, filename, content);
		const currentPhase = this.getCurrentPhase();

		const artifact: WorkflowArtifact = {
			name,
			filePath,
			mimeType,
			collectedAt: Date.now(),
			phaseId: currentPhase?.id,
		};

		this.state.artifacts.push(artifact);
		this.persist();
		return artifact;
	}

	/** Set a context value */
	setContext(key: string, value: string): void {
		this.state.context[key] = value;
		this.persist();
	}

	/** Apply multiple collect_artifact and set_context operations with a single persist */
	batchOperations(ops: Array<
		| { op: "collect_artifact"; name: string; content: string | Buffer; mimeType?: string }
		| { op: "set_context"; key: string; value: string }
	>): void {
		for (const op of ops) {
			if (op.op === "collect_artifact") {
				const filename = op.name.replace(/[^a-zA-Z0-9._-]/g, "_");
				const filePath = storeArtifact(this.state.sessionId, filename, op.content);
				const currentPhase = this.getCurrentPhase();
				const artifact: WorkflowArtifact = {
					name: op.name,
					filePath,
					mimeType: op.mimeType ?? "text/plain",
					collectedAt: Date.now(),
					phaseId: currentPhase?.id,
				};
				this.state.artifacts.push(artifact);
			} else if (op.op === "set_context") {
				this.state.context[op.key] = op.value;
			}
		}
		this.persist();
	}

	/** Mark workflow as failed */
	fail(reason?: string): void {
		this.state.status = "failed";
		this.state.completedAt = Date.now();
		if (reason) this.state.context["failure_reason"] = reason;

		// Still generate a report for failed workflows
		this.generateAndStoreReport();
		this.persist();
		this.onChange?.(this.getState());
	}

	/** Cancel the workflow */
	cancel(): void {
		this.state.status = "cancelled";
		this.state.completedAt = Date.now();
		this.generateAndStoreReport();
		this.persist();
		this.onChange?.(this.getState());
	}

	/** Mark complete (called when advancing past the last phase) */
	complete(): void {
		if (this.state.status !== "running") return;
		this.state.status = "completed";
		this.state.completedAt = Date.now();

		// Complete active phase
		const currentRecord = this.state.phaseHistory.find(
			(r) => r.phaseId === this.getCurrentPhase()?.id && r.status === "active",
		);
		if (currentRecord) {
			currentRecord.status = "completed";
			currentRecord.completedAt = this.state.completedAt;
		}

		this.generateAndStoreReport();
		this.persist();
		this.onChange?.(this.getState());
	}

	/**
	 * Server-side synthesis of code review findings.
	 * Reads delegate output artifacts, merges/deduplicates/sorts findings,
	 * stores the merged artifact, and sets all context values.
	 * Returns the number of findings.
	 *
	 * Core logic lives in `synthesis.ts` — this method delegates to it
	 * and applies the results to workflow state.
	 */
	synthesiseFindings(): number {
		const currentPhase = this.getCurrentPhase();
		const result = synthesiseReviewFindings(this.state.sessionId, currentPhase?.id);

		this.state.artifacts.push(result.artifact);
		this.state.context["finding_count"] = String(result.findings.length);
		this.state.context["critical_count"] = String(result.criticalCount);
		this.state.context["major_count"] = String(result.majorCount);
		this.state.context["minor_count"] = String(result.minorCount);
		this.state.context["nit_count"] = String(result.nitCount);
		this.state.context["verdict"] = result.verdict;
		this.state.context["summary"] = result.summary;

		this.persist();
		return result.findings.length;
	}

	private generateAndStoreReport(): void {
		try {
			const html = generateReport(this.workflow, this.state);
			const reportPath = storeArtifact(this.state.sessionId, "report.html", html);
			this.state.reportPath = reportPath;
		} catch (err) {
			console.error(`[workflow] Failed to generate report for ${this.state.sessionId}:`, err);
		}
	}

	private persist(): void {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		const filePath = path.join(STATE_DIR, `${this.state.sessionId}.json`);
		fs.writeFileSync(filePath, JSON.stringify(this.state, null, 2), "utf-8");
	}

	/** Remove persisted state */
	static cleanup(sessionId: string): void {
		const filePath = path.join(STATE_DIR, `${sessionId}.json`);
		try {
			fs.unlinkSync(filePath);
		} catch {
			// ignore
		}
	}
}
