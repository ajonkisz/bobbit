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

	// ── Execution control (two orthogonal axes) ──

	/**
	 * Whether this phase runs as a sub-agent process or inline in the parent session.
	 * - false (default): executed by the current agent in the parent session
	 * - true: executed by a spawned sub-agent process
	 *
	 * Sub-agents always run to completion before the workflow advances.
	 */
	subAgent?: boolean;

	/**
	 * Context isolation for sub-agent phases. Ignored when subAgent is false.
	 * - "full" (default for sub-agents): agent gets ONLY phase instructions + AGENTS.md.
	 *   No parent conversation, no goal spec. Maximum independence/unbiased review.
	 * - "goal": agent gets phase instructions + AGENTS.md + the original goal spec.
	 *   Useful when the sub-agent needs to understand the broader objective.
	 * - "none": agent inherits the parent session's full conversation context.
	 *   Useful for offloading work that needs the parent's context (e.g., "run this test").
	 */
	isolation?: "full" | "goal" | "none";

	/**
	 * For container phases: sub-phases to run concurrently as parallel sub-agents.
	 * Each sub-phase inherits its own `subAgent`, `isolation`, and `timeoutMs` settings.
	 * If a sub-phase doesn't set `subAgent`, it defaults to true (since it's in a parallel group).
	 * The container phase completes when all sub-phases finish.
	 */
	parallelPhases?: Phase[];

	/** Timeout in ms for sub-agent execution (default: 10 minutes). Ignored for inline phases. */
	timeoutMs?: number;
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
