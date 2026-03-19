/**
 * Skill definition types.
 *
 * A skill is a named, reusable template for spawning an isolated sub-agent
 * that produces a structured artifact. Skills replace the multi-phase workflow
 * engine with a simpler, single-invocation model.
 */

export interface Skill {
	/** Unique identifier, e.g. "code-review", "gap-analysis" */
	id: string;
	/** Human-readable name */
	name: string;
	/** What this skill does */
	description: string;
	/** System prompt / instructions for the isolated sub-agent */
	instructions: string;
	/** Whether the sub-agent sees parent context */
	isolation: "full" | "partial";
	/** Description of expected artifact format */
	expectedOutput: string;
	/** Max execution time in ms (default 10 minutes) */
	timeoutMs?: number;
}
