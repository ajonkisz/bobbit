/**
 * Code review skills.
 *
 * Converted from the multi-phase code-review workflow into three independent
 * skills. Each reviews a different aspect of a branch diff. The Team Lead
 * invokes them individually (or in parallel) and synthesises the results.
 *
 * Expected context:
 *   - base_branch: branch to diff against
 *   - feature_branch: branch being reviewed
 *   - repo_path: absolute path to the repository
 */

import type { Skill } from "../types.js";

export const correctnessReview: Skill = {
	id: "correctness-review",
	name: "Correctness & Completeness Review",
	description:
		"Reviews a branch diff for correctness and completeness issues: logic errors, off-by-one, wrong conditions, unhandled errors, race conditions, type mismatches, missing awaits, missing edge cases.",
	instructions: `You are a code reviewer. Review the diff for correctness and completeness issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values provided in your context). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: logic errors, off-by-one, wrong conditions, unhandled errors, race conditions, type mismatches, missing awaits, missing edge cases, unvalidated inputs, TODOs.

Output ONLY a JSON array of findings. Each finding: {"id":"FC001","file":"path","lineRange":"1-10","category":"correctness|completeness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
	isolation: "full",
	expectedOutput: "JSON array of finding objects with id, file, lineRange, category, severity, title, description, suggestion",
	timeoutMs: 300_000,
};

export const securityReview: Skill = {
	id: "security-review",
	name: "Security & Robustness Review",
	description:
		"Reviews a branch diff for security and robustness issues: injection, path traversal, XSS, hardcoded secrets, unsafe eval, missing auth, resource leaks.",
	instructions: `You are a security reviewer. Review the diff for security and robustness issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values provided in your context). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: command injection, path traversal, XSS, hardcoded secrets, unsafe eval/deserialization, missing auth, resource leaks, unhandled rejections, missing input validation, crash paths.

Output ONLY a JSON array of findings. Each finding: {"id":"FS001","file":"path","lineRange":"1-10","category":"security|robustness","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
	isolation: "full",
	expectedOutput: "JSON array of finding objects with id, file, lineRange, category, severity, title, description, suggestion",
	timeoutMs: 300_000,
};

export const designReview: Skill = {
	id: "design-review",
	name: "Design & Performance Review",
	description:
		"Reviews a branch diff for design, performance, and maintainability issues: wrong abstraction level, unnecessary duplication, inconsistent naming, O(n²) algorithms, poor testability.",
	instructions: `You are a design reviewer. Review the diff for design, performance, and maintainability issues.

Run: \`git diff {base_branch}...{feature_branch}\` (values provided in your context). Read the diff output ONLY — do NOT read individual source files or explore the repo.

Look for: wrong abstraction level, unnecessary duplication, inconsistent naming, O(n²) algorithms, unnecessary allocations, sync I/O blocking, magic numbers, poor testability.

Output ONLY a JSON array of findings. Each finding: {"id":"FD001","file":"path","lineRange":"1-10","category":"design|performance|maintainability","severity":"critical|major|minor|nit","title":"...","description":"...","suggestion":"..."}

If no issues: []. No prose before or after the JSON.`,
	isolation: "full",
	expectedOutput: "JSON array of finding objects with id, file, lineRange, category, severity, title, description, suggestion",
	timeoutMs: 300_000,
};
