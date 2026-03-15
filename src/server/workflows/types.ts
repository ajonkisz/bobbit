/**
 * Workflow definition and runtime types.
 */

/** A single phase in a workflow */
export interface Phase {
	id: string;
	name: string;
	/** Markdown instructions injected into agent context */
	instructions: string;
	/** Human-readable description of what must be true to exit this phase */
	exitCriteria: string;
}

/** A workflow definition (template) */
export interface Workflow {
	id: string;
	name: string;
	description: string;
	phases: Phase[];
}

/** Runtime state for a phase that has been entered */
export interface PhaseRecord {
	phaseId: string;
	startedAt: number;
	completedAt?: number;
	status: "active" | "completed" | "skipped" | "reset";
}

/** Artifact collected during workflow execution */
export interface WorkflowArtifact {
	name: string;
	/** File path on disk (inside ~/.pi/workflow-artifacts/{sessionId}/) */
	filePath: string;
	/** MIME type */
	mimeType: string;
	/** When the artifact was collected */
	collectedAt: number;
	/** Optional phase it belongs to */
	phaseId?: string;
}

/** Complete runtime state of a workflow execution */
export interface WorkflowState {
	/** Workflow definition id */
	workflowId: string;
	/** Session this workflow is running in */
	sessionId: string;
	/** Overall status */
	status: "running" | "completed" | "failed" | "cancelled";
	/** Index into workflow.phases for current phase */
	currentPhaseIndex: number;
	/** History of all phase transitions */
	phaseHistory: PhaseRecord[];
	/** Collected artifacts */
	artifacts: WorkflowArtifact[];
	/** When the workflow started */
	startedAt: number;
	/** When the workflow completed (if done) */
	completedAt?: number;
	/** Path to generated HTML report (if completed) */
	reportPath?: string;
	/** Extra context (e.g., worktree path, branch name) */
	context: Record<string, string>;
}
