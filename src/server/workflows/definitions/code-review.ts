import type { Workflow } from "../types.js";

/**
 * Code Review workflow.
 *
 * Designed for **context isolation**: the reviewing sub-agents receive only the
 * git diff, the spec (optionally), and AGENTS.md — never the implementation
 * conversation. This ensures the review is independent and unbiased.
 *
 * Phase execution:
 *   - "gather-diff": inline (parent agent collects the diff)
 *   - "review-parallel": parallel group of 3 sub-agents with full isolation
 *   - "synthesise-findings": inline (parent merges results)
 *   - "complete-review": inline (triggers report generation)
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
			instructions: `Collect the diff and understand the scope of changes.

1. Read the workflow context values: \`base_branch\`, \`feature_branch\`, \`repo_path\`
2. Generate the unified diff:
   \`\`\`
   git diff {base_branch}...{feature_branch}
   \`\`\`
   (Use two-dot \`{base_branch}..{feature_branch}\` if the branches share HEAD, or \`git diff HEAD\` for uncommitted changes.)
3. Collect the diff as an artifact named "diff.patch" (mime: text/x-diff)
4. Generate a file-level summary: list every changed file with a one-line description of what changed
5. Collect the summary as an artifact named "change-summary.txt"
6. If a "spec" context value exists, read it carefully — it describes what the changes SHOULD accomplish

**Important**: You are performing an independent review. Focus only on what the diff shows, not on how or why decisions were made. You should be a fresh pair of eyes.

After collecting the diff and summarising changes, advance to the next phase.`,
			exitCriteria:
				"Diff collected as artifact, file-level change summary produced",
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
					instructions: `You are an independent code reviewer. Analyse the diff for correctness and completeness.

Review each changed file and ask:

**Correctness**
- Are there logic errors, off-by-one mistakes, or wrong conditions?
- Are error cases handled? What happens on null/undefined/empty inputs?
- Are there race conditions or concurrency issues?
- Do type signatures match usage? Any implicit \`any\` or unsafe casts?
- Are promises properly awaited? Are error paths caught?

**Completeness**
- If a spec was provided, does the implementation satisfy every requirement?
- Are there missing edge cases the spec implies but the code doesn't handle?
- Are there new public APIs without validation or documentation?
- Are there TODOs or placeholder implementations that should be flagged?

For each issue found, produce a JSON finding with this shape:
\`\`\`json
{"id":"FC001","file":"path","lineRange":"1-10","category":"correctness|completeness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}
\`\`\`

Collect ALL findings as a single artifact named "findings-correctness.json" (mime: application/json).
The artifact should be a JSON array of findings. If no issues found, collect an empty array \`[]\`.`,
					exitCriteria: "All changed files reviewed for correctness, findings artifact collected",
					timeoutMs: 600_000,
				},
				{
					id: "review-security",
					name: "Review: Security & Robustness",
					subAgent: true,
					isolation: "full",
					instructions: `You are an independent security reviewer. Analyse the diff for security vulnerabilities and robustness issues.

**Security**
- Command injection: any user input reaching \`exec\`, \`execSync\`, \`spawn\`, or shell commands?
- Path traversal: file operations with unsanitised user-controlled paths?
- Injection: SQL injection, XSS, template injection, JSONL injection?
- Secrets: hardcoded tokens, keys, passwords, or credentials?
- Unsafe deserialisation: \`eval\`, \`Function()\`, unvalidated JSON.parse on untrusted input?
- Authentication/authorisation: are new endpoints/handlers properly gated?
- Dependency issues: new dependencies with known vulnerabilities?

**Robustness**
- Resource leaks: file handles, sockets, child processes not cleaned up?
- Crash paths: unhandled promise rejections, missing try/catch on I/O?
- Input validation: are inputs from external sources (network, files, env) validated?
- Graceful degradation: what happens when external services are unavailable?

For each issue found, produce a JSON finding with this shape:
\`\`\`json
{"id":"FS001","file":"path","lineRange":"1-10","category":"security|robustness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}
\`\`\`

Collect ALL findings as a single artifact named "findings-security.json" (mime: application/json).
The artifact should be a JSON array of findings. If no issues found, collect an empty array \`[]\`.`,
					exitCriteria: "All changed files reviewed for security, findings artifact collected",
					timeoutMs: 600_000,
				},
				{
					id: "review-design",
					name: "Review: Design & Performance",
					subAgent: true,
					isolation: "full",
					instructions: `You are an independent design reviewer. Analyse the diff for design quality, performance, and maintainability.

**Design & Architecture**
- Does the code fit the existing architecture and patterns of the codebase?
- Are abstractions at the right level? Too much indirection? Too little?
- Is there unnecessary duplication that should be extracted?
- Are naming conventions consistent with the rest of the codebase?
- Is the module/file structure logical?

**Performance**
- Are there O(n²) or worse algorithms where linear would work?
- Unnecessary allocations in hot paths (e.g., building strings/arrays in loops)?
- Synchronous I/O on the main thread that could block?
- Missing caching where expensive operations repeat?
- Large payloads being copied instead of streamed?

**Maintainability**
- Is the code easy to understand for the next developer?
- Are complex sections adequately commented?
- Are there magic numbers or strings that should be constants?
- Is the test surface obvious — can someone write tests for this code easily?

For each issue found, produce a JSON finding with this shape:
\`\`\`json
{"id":"FD001","file":"path","lineRange":"1-10","category":"design|performance|maintainability","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}
\`\`\`

Collect ALL findings as a single artifact named "findings-design.json" (mime: application/json).
The artifact should be a JSON array of findings. If no issues found, collect an empty array \`[]\`.`,
					exitCriteria: "All changed files reviewed for design, findings artifact collected",
					timeoutMs: 600_000,
				},
			],
		},
		{
			id: "synthesise-findings",
			name: "Synthesise Findings",
			instructions: `Merge findings from the three parallel review sub-agents into a single structured artifact.

1. Read the artifacts: "findings-correctness.json", "findings-security.json", "findings-design.json"
2. Merge all findings into one array
3. Re-number IDs sequentially: F001, F002, ...
4. Sort by severity: critical first, then major, minor, nit
5. Deduplicate: if two reviewers flagged the same issue, keep the more detailed one

**Severity guidelines:**
- **critical**: Will cause bugs in production, data loss, security vulnerability, or crash
- **major**: Significant issue that should be fixed before merge — wrong behaviour, missing validation, poor error handling
- **minor**: Worth fixing but not a blocker — suboptimal patterns, missing edge cases with low likelihood
- **nit**: Style preference, naming suggestion, minor readability improvement

Collect the merged array as artifact "review-findings.json" (mime: application/json).

Set these context values:
- \`finding_count\`: total number of findings
- \`critical_count\`: number of critical findings
- \`major_count\`: number of major findings
- \`minor_count\`: number of minor findings
- \`nit_count\`: number of nit findings
- \`verdict\`: one of "approve", "request-changes", or "comment"
  - "approve" — no critical or major issues; ship it
  - "request-changes" — critical or major issues that must be addressed
  - "comment" — only minor/nit issues; up to the author
- \`summary\`: a 1-2 sentence plain-text summary of the overall review

Then advance to complete the workflow.`,
			exitCriteria:
				"Merged findings artifact collected with counts and verdict in context",
		},
		{
			id: "complete-review",
			name: "Complete Review",
			instructions: `Finalise the review.

The workflow engine will automatically generate an HTML report from the findings.

Complete the workflow now.`,
			exitCriteria: "Workflow completed and report generated",
		},
	],
};
