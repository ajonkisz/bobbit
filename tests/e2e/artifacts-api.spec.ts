import { test, expect, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:3099";
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
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	token = fs.readFileSync(path.join(os.homedir(), ".pi", "gateway-token"), "utf-8").trim();
});

let goalId: string;

test.beforeEach(async () => {
	// Create a fresh goal for each test
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Test Goal " + Date.now(),
			spec: "Test spec",
			cwd: process.cwd(),
			team: true,
		}),
	});
	const goal = await resp.json();
	goalId = goal.id;
});

test.afterEach(async () => {
	if (goalId) {
		await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
	}
});

test.describe("Goal Artifacts API", () => {
	test("CRUD lifecycle", async () => {
		// Create
		const createResp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "test-design-doc",
				type: "design-doc",
				content: "# Design\nThis is a test design document.",
				producedBy: "test-session-123",
			}),
		});
		expect(createResp.status).toBe(201);
		const artifact = await createResp.json();
		expect(artifact.id).toBeTruthy();
		expect(artifact.type).toBe("design-doc");
		expect(artifact.version).toBe(1);
		expect(artifact.content).toContain("test design document");

		// List
		const listResp = await apiFetch(`/api/goals/${goalId}/artifacts`);
		expect(listResp.status).toBe(200);
		const { artifacts } = await listResp.json();
		expect(artifacts.length).toBe(1);
		expect(artifacts[0].id).toBe(artifact.id);

		// Get
		const getResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`);
		expect(getResp.status).toBe(200);
		const fetched = await getResp.json();
		expect(fetched.content).toContain("test design document");

		// Update (revision)
		const updateResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`, {
			method: "PUT",
			body: JSON.stringify({ content: "# Design v2\nRevised content." }),
		});
		expect(updateResp.status).toBe(200);
		const updated = await updateResp.json();
		expect(updated.version).toBe(2);
		expect(updated.content).toContain("Revised content");
	});

	test("returns 404 for non-existent artifact", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts/nonexistent-id`);
		expect(resp.status).toBe(404);
	});

	test("returns empty list for goal with no artifacts", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`);
		const { artifacts } = await resp.json();
		expect(artifacts).toEqual([]);
	});
});

test.describe("Artifact Requirement Enforcement", () => {
	test("blocks implementation task when design-doc is missing", async () => {
		// Try to create an implementation task without a design-doc artifact
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Implement feature X",
				type: "implementation",
				spec: "Build the thing",
			}),
		});
		expect(resp.status).toBe(409);
		const body = await resp.json();
		expect(body.error).toBeTruthy();
		expect(body.missingArtifacts).toBeTruthy();
		expect(body.missingArtifacts.some((a: any) => a.type === "design-doc")).toBe(true);
	});

	test("allows implementation task after design-doc exists", async () => {
		// Create the required design-doc artifact
		await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "design-doc",
				type: "design-doc",
				content: "# Design\nThe plan.",
				producedBy: "test-session",
			}),
		});

		// Now implementation task should succeed
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Implement feature X",
				type: "implementation",
				spec: "Build the thing",
			}),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.id).toBeTruthy();
	});

	test("allows non-implementation tasks without design-doc", async () => {
		// A refactor task should not be blocked by missing design-doc
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({
				title: "Refactor something",
				type: "refactor",
				spec: "Clean up code",
			}),
		});
		// Should succeed (refactor is not blocked by design-doc requirement)
		expect(resp.status).toBe(201);
	});
});

test.describe("Skills API", () => {
	test("GET /api/skills returns skill definitions", async () => {
		const resp = await apiFetch("/api/skills");
		expect(resp.status).toBe(200);
		const { skills } = await resp.json();
		expect(Array.isArray(skills)).toBe(true);
		// Should have the built-in skills
		const ids = skills.map((s: any) => s.id);
		expect(ids).toContain("correctness-review");
		expect(ids).toContain("security-review");
		expect(ids).toContain("design-review");
		expect(ids).toContain("test-suite-report");
	});
});
