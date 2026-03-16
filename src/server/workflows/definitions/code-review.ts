import type { Workflow } from "../types.js";

/**
 * Code Review workflow.
 *
 * Designed for **context isolation**: the reviewing sub-agents receive only the
 * git diff, the spec (optionally), and AGENTS.md — never the implementation
 * conversation. This ensures the review is independent and unbiased.
 *
 * Phase execution (3 phases, optimised for speed):
 *   - "gather-diff": inline — run git diff, save as artifact, set context, advance
 *   - "review-parallel": parallel group of 3 sub-agents (read diff via git)
 *   - "synthesise-and-complete": inline — synthesise + complete in one step
 *
 * Expected workflow context inputs:
 *   - `base_branch`    — branch to diff against (e.g. "main")
 *   - `feature_branch` — branch being reviewed
 *   - `repo_path`      — absolute path to the repository
 *   - `spec`           — the original spec / goal description (optional)
 */
export const codeReview: Workflow = {
	id: "code-review",
	name: "Code Review",
	description:
		"Independent, unbiased code review of a branch diff. Produces structured findings categorised by type and severity.",
	phases: [
		{
			id: "gather-diff",
			name: "Gather Diff",
			instructions: `Set branch context and advance. That is ALL you do in this phase.

Call these workflow tool actions in ONE parallel batch, then advance:

1. \`set_context\` key="base_branch" value=<base branch>
2. \`set_context\` key="feature_branch" value=<feature branch>
3. \`set_context\` key="repo_path" value=<absolute repo path>

Then call \`advance\`.

Do NOT run git diff. Do NOT read any files. Do NOT explore the repo. The review delegates handle everything.`,
			exitCriteria:
				"Context values set, advanced",
		},
		{
			id: "review-parallel",
			name: "Parallel Review",
			instructions: "Call the workflow tool with `action: \"run_phase\"` now. " +
				"The tool handles everything internally — just call it and wait for it to return. " +
				"Then advance.",
			exitCriteria: "All three review sub-agents have completed",
			parallelPhases: [
				{
					id: "review-correctness",
					name: "Review: Correctness & Completeness",
					subAgent: true,
					isolation: "full",
					instructions: `You are a code reviewer. Review the diff for correctness and completeness issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values in Context below). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: logic errors, off-by-one, wrong conditions, unhandled errors, race conditions, type mismatches, missing awaits, missing edge cases, unvalidated inputs, TODOs.

Output ONLY a JSON array of findings. Each finding: {"id":"FC001","file":"path","lineRange":"1-10","category":"correctness|completeness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
					exitCriteria: "JSON array output",
					timeoutMs: 300_000,
				},
				{
					id: "review-security",
					name: "Review: Security & Robustness",
					subAgent: true,
					isolation: "full",
					instructions: `You are a security reviewer. Review the diff for security and robustness issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values in Context below). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: command injection, path traversal, XSS, hardcoded secrets, unsafe eval/deserialization, missing auth, resource leaks, unhandled rejections, missing input validation, crash paths.

Output ONLY a JSON array of findings. Each finding: {"id":"FS001","file":"path","lineRange":"1-10","category":"security|robustness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
					exitCriteria: "JSON array output",
					timeoutMs: 300_000,
				},
				{
					id: "review-design",
					name: "Review: Design & Performance",
					subAgent: true,
					isolation: "full",
					instructions: `You are a design reviewer. Review the diff for design, performance, and maintainability issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values in Context below). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: wrong abstraction level, unnecessary duplication, inconsistent naming, O(n²) algorithms, unnecessary allocations, sync I/O blocking, magic numbers, poor testability.

Output ONLY a JSON array of findings. Each finding: {"id":"FD001","file":"path","lineRange":"1-10","category":"design|performance|maintainability","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
					exitCriteria: "JSON array output",
					timeoutMs: 300_000,
				},
			],
		},
		{
			id: "synthesise-and-complete",
			name: "Synthesise & Complete",
			instructions: `Synthesise findings and complete the review.

Call workflow tool with \`action: "synthesise_review"\` — this merges all delegate findings, deduplicates, sorts by severity, and sets verdict/counts in context.

Then immediately call workflow tool with \`action: "complete"\`.

Do not add any commentary. Just call those two actions.`,
			exitCriteria:
				"Findings merged, workflow completed",
		},
	],
};
