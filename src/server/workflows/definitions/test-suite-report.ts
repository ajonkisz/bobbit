import type { Workflow } from "../types.js";

export const testSuiteReport: Workflow = {
	id: "test-suite-report",
	name: "Test Suite Report",
	description:
		"Creates a git worktree, builds the project, runs tests, and generates an HTML report with results.",
	phases: [
		{
			id: "create-worktree",
			name: "Create Worktree",
			instructions: `Create an isolated git worktree for running the test suite.

1. Pick a branch name like \`test-run-{timestamp}\`
2. Run: \`git worktree add -b {branch} {worktree-path} HEAD\`
3. The worktree should be a sibling directory of the main repo
4. Record the worktree path and branch name using workflow context

After creating the worktree, advance to the next phase.`,
			exitCriteria: "Git worktree exists on a new branch at the recorded path",
		},
		{
			id: "compile",
			name: "Compile",
			instructions: `Build the project in the worktree directory.

1. cd into the worktree path
2. Run \`npm install\` if needed
3. Run the project's build command (e.g. \`npm run build\`)
4. Capture build output — collect it as an artifact named "build-output.txt"
5. If the build fails, collect the error output and fail the workflow

After a successful build, advance to the next phase.`,
			exitCriteria: "Project compiles successfully in the worktree",
		},
		{
			id: "run-tests",
			name: "Run Tests",
			instructions: `Run the project's test suite in the worktree.

1. cd into the worktree path
2. Run the test command (e.g. \`npm test\`)
3. Capture ALL test output — collect it as an artifact named "test-output.txt"
4. Note: tests may fail — that's OK, we're generating a report, not gating on pass/fail

After running tests (regardless of pass/fail), advance to the next phase.`,
			exitCriteria: "Tests have been executed and output captured",
		},
		{
			id: "generate-report",
			name: "Generate Report",
			instructions: `The workflow engine will automatically generate an HTML report when you complete the workflow.

Review the collected artifacts and add any additional context:
- Set context "test_result" to "pass" or "fail"  
- Set context "pass_count" and "fail_count" if you can parse them from test output
- Set context "summary" with a brief one-line description of results

Then complete the workflow.`,
			exitCriteria: "Report generated and stored as session artifact",
		},
		{
			id: "cleanup",
			name: "Clean Up",
			instructions: `Remove the git worktree and branch.

1. Run: \`git worktree remove {worktree-path} --force\`
2. Run: \`git worktree prune\`  
3. Optionally delete the branch: \`git branch -D {branch}\`

This is the final phase. The workflow is complete.`,
			exitCriteria: "Worktree and branch removed",
		},
	],
};
