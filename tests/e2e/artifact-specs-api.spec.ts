import { test, expect } from "@playwright/test";
import { readE2EToken } from "./e2e-setup.js";

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

async function createGoal(): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: "Artifact Spec Test Goal " + Date.now(),
			spec: "Test spec",
			cwd: process.cwd(),
			team: true,
		}),
	});
	const goal = await resp.json();
	return goal.id;
}

test.beforeAll(async () => {
	token = readE2EToken();
});

test.describe("Artifact Spec CRUD API", () => {
	test("GET /api/artifact-specs returns built-in defaults", async () => {
		const resp = await apiFetch("/api/artifact-specs");
		expect(resp.status).toBe(200);
		const { specs } = await resp.json();
		expect(Array.isArray(specs)).toBe(true);
		const ids = specs.map((s: any) => s.id);
		expect(ids).toContain("design-doc");
		expect(ids).toContain("test-plan");
		expect(ids).toContain("implementation");
		expect(ids).toContain("code-review");
		expect(ids).toContain("security-review");
		expect(ids).toContain("test-results");
		expect(ids).toContain("summary-report");
	});

	test("POST creates a new spec, GET retrieves it, PUT updates it, DELETE removes it", async () => {
		const specId = "e2e-crud-test-" + Date.now();

		// POST — create
		const createResp = await apiFetch("/api/artifact-specs", {
			method: "POST",
			body: JSON.stringify({
				id: specId,
				name: "E2E Test Spec",
				kind: "analysis",
				format: "markdown",
				description: "A test spec",
				mustHave: ["item1"],
				shouldHave: ["item2"],
			}),
		});
		expect(createResp.status).toBe(201);
		const spec = await createResp.json();
		expect(spec.id).toBe(specId);
		expect(spec.name).toBe("E2E Test Spec");
		expect(spec.kind).toBe("analysis");
		expect(spec.format).toBe("markdown");
		expect(spec.mustHave).toEqual(["item1"]);

		// GET — retrieve by id
		const getResp = await apiFetch(`/api/artifact-specs/${specId}`);
		expect(getResp.status).toBe(200);
		const fetched = await getResp.json();
		expect(fetched.id).toBe(specId);
		expect(fetched.name).toBe("E2E Test Spec");

		// PUT — update
		const updateResp = await apiFetch(`/api/artifact-specs/${specId}`, {
			method: "PUT",
			body: JSON.stringify({ name: "Updated Name", description: "Updated desc" }),
		});
		expect(updateResp.status).toBe(200);
		const updated = await updateResp.json();
		expect(updated.name).toBe("Updated Name");
		expect(updated.description).toBe("Updated desc");

		// DELETE — remove
		const deleteResp = await apiFetch(`/api/artifact-specs/${specId}`, {
			method: "DELETE",
		});
		expect(deleteResp.status).toBe(204);

		// Verify gone
		const gone = await apiFetch(`/api/artifact-specs/${specId}`);
		expect(gone.status).toBe(404);
	});

	test("POST with missing fields returns 400", async () => {
		const resp = await apiFetch("/api/artifact-specs", {
			method: "POST",
			body: JSON.stringify({ id: "missing-fields" }),
		});
		expect(resp.status).toBe(400);
	});

	test("GET nonexistent returns 404", async () => {
		const resp = await apiFetch("/api/artifact-specs/nonexistent-spec-id");
		expect(resp.status).toBe(404);
	});

	test("PUT nonexistent returns 404", async () => {
		const resp = await apiFetch("/api/artifact-specs/nonexistent-spec-id", {
			method: "PUT",
			body: JSON.stringify({ name: "nope" }),
		});
		expect(resp.status).toBe(404);
	});

	test("DELETE nonexistent returns 404", async () => {
		const resp = await apiFetch("/api/artifact-specs/nonexistent-spec-id", {
			method: "DELETE",
		});
		expect(resp.status).toBe(404);
	});
});

test.describe("Task creation — free-form types", () => {
	let goalId: string;

	test.beforeAll(async () => {
		goalId = await createGoal();
	});
	test.afterAll(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
	});

	test("accepts any task type string", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Custom type task", type: "my-custom-type" }),
		});
		expect(resp.status).toBe(201);
		const task = await resp.json();
		expect(task.type).toBe("my-custom-type");
	});

	test("implementation task no longer blocked by missing artifacts", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/tasks`, {
			method: "POST",
			body: JSON.stringify({ title: "Implement feature", type: "implementation" }),
		});
		expect(resp.status).toBe(201);
	});
});

test.describe("Artifact creation — spec enforcement", () => {
	let goalId: string;

	test.beforeAll(async () => {
		goalId = await createGoal();
	});
	test.afterAll(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
	});

	test("artifact with specId enforces requires chain", async () => {
		// implementation spec requires design-doc and test-plan
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "impl",
				type: "implementation",
				specId: "implementation",
				content: "# Impl",
				producedBy: "test-session",
			}),
		});
		expect(resp.status).toBe(409);
		const body = await resp.json();
		expect(body.missingSpecs).toBeTruthy();
		expect(body.missingSpecs).toContain("design-doc");
		expect(body.missingSpecs).toContain("test-plan");
	});

	test("artifact creation succeeds when requires are met", async () => {
		// Create design-doc and test-plan artifacts first
		const r1 = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "design",
				type: "design-doc",
				specId: "design-doc",
				content: "# Design",
				producedBy: "test",
			}),
		});
		expect(r1.status).toBe(201);

		const r2 = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "tests",
				type: "test-plan",
				specId: "test-plan",
				content: "# Tests",
				producedBy: "test",
			}),
		});
		expect(r2.status).toBe(201);

		// Now implementation should succeed
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "impl",
				type: "implementation",
				specId: "implementation",
				content: "# Implementation",
				producedBy: "test",
			}),
		});
		expect(resp.status).toBe(201);
	});

	test("artifact without specId has no enforcement", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "free-artifact",
				type: "implementation",
				content: "# No specId",
				producedBy: "test",
			}),
		});
		expect(resp.status).toBe(201);
	});
});

test.describe("GoalArtifact new fields", () => {
	let goalId: string;

	test.beforeAll(async () => {
		goalId = await createGoal();
	});
	test.afterAll(async () => {
		if (goalId) await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
	});

	test("specId and status are persisted", async () => {
		const createResp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "test-artifact",
				type: "design-doc",
				specId: "design-doc",
				status: "accepted",
				content: "# Design",
				producedBy: "test",
			}),
		});
		expect(createResp.status).toBe(201);
		const artifact = await createResp.json();
		expect(artifact.specId).toBe("design-doc");
		expect(artifact.status).toBe("accepted");

		// Verify via GET
		const getResp = await apiFetch(`/api/goals/${goalId}/artifacts/${artifact.id}`);
		const fetched = await getResp.json();
		expect(fetched.specId).toBe("design-doc");
		expect(fetched.status).toBe("accepted");
	});

	test("status defaults to submitted when not provided", async () => {
		const resp = await apiFetch(`/api/goals/${goalId}/artifacts`, {
			method: "POST",
			body: JSON.stringify({
				name: "default-status",
				type: "custom",
				content: "# Test",
				producedBy: "test",
			}),
		});
		expect(resp.status).toBe(201);
		const artifact = await resp.json();
		expect(artifact.status).toBe("submitted");
	});
});
