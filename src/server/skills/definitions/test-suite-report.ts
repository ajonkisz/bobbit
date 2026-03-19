/**
 * Test suite report skill.
 *
 * Converted from the multi-phase test-suite-report workflow into a single
 * skill invocation. The sub-agent handles the full lifecycle: create worktree,
 * build, run tests, collect output, generate summary, and clean up.
 */

import type { Skill } from "../types.js";

export const testSuiteReportSkill: Skill = {
	id: "test-suite-report",
	name: "Test Suite Report",
	description:
		"Creates an isolated git worktree, builds the project, runs the full test suite, and produces a structured report with pass/fail counts and failure details.",
	instructions: `You are a test runner. Execute the full test suite and produce a structured report.

Steps:
1. Create an isolated git worktree:
   - Pick a branch name like \`test-run-{timestamp}\`
   - Run: \`git worktree add -b {branch} {worktree-path} HEAD\`
   - The worktree should be a sibling directory of the main repo

2. Build the project in the worktree:
   - cd into the worktree path
   - Run \`npm install\` if needed
   - Run the project's build command (e.g. \`npm run build\`)
   - If the build fails, report the build error and stop

3. Run the test suite:
   - Run the test command (e.g. \`npm test\`)
   - Capture ALL test output

4. Produce a structured report as JSON:
   {
     "buildStatus": "pass" | "fail",
     "buildOutput": "...",
     "testStatus": "pass" | "fail",
     "testOutput": "...",
     "passCount": <number>,
     "failCount": <number>,
     "failures": [{"test": "name", "error": "message"}],
     "summary": "one-line description"
   }

5. Clean up:
   - Run: \`git worktree remove {worktree-path} --force\`
   - Run: \`git worktree prune\`
   - Delete the branch: \`git branch -D {branch}\`

Output the JSON report as your final message.`,
	isolation: "full",
	expectedOutput: "JSON object with buildStatus, testStatus, passCount, failCount, failures array, and summary",
	timeoutMs: 600_000, // 10 minutes — tests can take a while
};
