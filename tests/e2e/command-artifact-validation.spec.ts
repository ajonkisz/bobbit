import { test, expect } from "@playwright/test";
import { readE2EToken, BASE } from "./e2e-setup.js";

let token: string;

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(opts?.headers || {}),
		},
	});
}

test.beforeAll(async () => {
	token = readE2EToken();
});

/**
 * Create a test workflow with one command-format artifact and one markdown-format artifact,
 * then create a goal referencing it.
 * Returns { goalId, workflowId, cleanup }.
 */
async function createGoalWithCommandWorkflow() {
	const workflowId = `test-wf-${Date.now()}`;

	// Create workflow with both a command and markdown artifact (no dependencies, no verification)
	const wfResp = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Test Command Workflow",
			description: "Test workflow for command artifact validation",
			artifacts: [
				{
					id: "test-cmd",
					name: "Test Command",
					description: "A test command artifact",
					kind: "verification",
					format: "command",
					dependsOn: [],
					mustHave: [],
					shouldHave: [],
					mustNotHave: [],
				},
				{
					id: "test-doc",
					name: "Test Document",
					description: "A test markdown artifact",
					kind: "analysis",
					format: "markdown",
					dependsOn: [],
					mustHave: [],
					shouldHave: [],
					mustNotHave: [],
				},
			],
		}),
	});
	expect(wfResp.status).toBe(201);

	// Create goal referencing the workflow
	const goalResp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Test Goal " + Date.now(),
			spec: "Test spec for command validation",
			cwd: process.cwd(),
			team: false,
			workflowId,
		}),
	});
	expect(goalResp.status).toBe(201);
	const goal = await goalResp.json();

	return {
		goalId: goal.id as string,
		workflowId,
		cleanup: async () => {
			await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" });
			await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
		},
	};
}

function createArtifactBody(content: string, workflowArtifactId: string) {
	return JSON.stringify({
		name: "test-artifact",
		type: "test",
		content,
		producedBy: "test-session",
		workflowArtifactId,
	});
}

test.describe("Command artifact validation", () => {
	let goalId: string;
	let workflowId: string;
	let cleanup: () => Promise<void>;

	test.beforeEach(async () => {
		const ctx = await createGoalWithCommandWorkflow();
		goalId = ctx.goalId;
		workflowId = ctx.workflowId;
		cleanup = ctx.cleanup;
	});

	test.afterEach(async () => {
		await cleanup();
	});

	// --- Rejection cases ---

	test("rejects empty content", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody("", "test-cmd"),
		});
		// Empty content is rejected by the existing "Missing content" check (400)
		expect(resp.status).toBe(400);
	});

	test("rejects whitespace-only content", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody("   \n\n  ", "test-cmd"),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("empty");
	});

	test("rejects content with markdown code fences", async () => {
		const content = "```bash\nnpx playwright test\n```";
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(content, "test-cmd"),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("code fences");
		expect(body.help).toBeTruthy();
	});

	test("rejects content starting with markdown heading", async () => {
		const content = "# Test Results\nnpx playwright test";
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(content, "test-cmd"),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("markdown heading");
	});

	test("rejects multi-line prose content", async () => {
		const content = [
			"This is a description of the test results.",
			"The tests were run on the CI server.",
			"All tests passed successfully.",
			"The coverage report shows 95% coverage.",
			"No regressions were found.",
			"The performance benchmarks look good too.",
		].join("\n");
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(content, "test-cmd"),
		});
		expect(resp.status).toBe(400);
		const body = await resp.json();
		expect(body.error).toContain("prose");
	});

	// --- Acceptance cases ---

	test("accepts valid single command", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody("npx playwright test foo.spec.ts", "test-cmd"),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts piped commands", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(
				"npm run build:server && npx playwright test --reporter=json 2>/dev/null | node scripts/test-filter.mjs",
				"test-cmd",
			),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts chained commands", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody("cd dir && npm test", "test-cmd"),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts multi-line shell with continuations", async () => {
		const content = [
			"npm run build:server &&",
			"npx playwright test --config playwright-e2e.config.ts &&",
			"npm run check &&",
			"echo done",
			"npm test",
			"git status",
		].join("\n");
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(content, "test-cmd"),
		});
		expect(resp.status).toBe(201);
	});

	// --- Non-command format bypass ---

	test("skips validation for non-command format", async () => {
		// Markdown content with headings and code fences should be fine for format: markdown
		const content = "# Test Results\n\n```\nSome output\n```\n\nAll good.";
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody(content, "test-doc"),
		});
		expect(resp.status).toBe(201);
	});

	test("skips validation for artifact without workflowArtifactId", async () => {
		const content = "# Whatever\n\n```bash\nsome stuff\n```";
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "no-workflow-link",
				type: "design-doc",
				content,
				producedBy: "test-session",
				// No workflowArtifactId
			}),
		});
		expect(resp.status).toBe(201);
	});

	// --- Validation on update ---

	test("validates on update (PUT) with malformed content", async () => {
		// First create a valid artifact
		const createResp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: createArtifactBody("npx playwright test", "test-cmd"),
		});
		expect(createResp.status).toBe(201);
		const artifact = await createResp.json();

		// Now try to update with malformed content
		const updateResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`, {
			method: "PUT",
			body: JSON.stringify({ content: "```bash\nnpx playwright test\n```" }),
		});
		expect(updateResp.status).toBe(400);
		const body = await updateResp.json();
		expect(body.error).toContain("code fences");
	});
});
