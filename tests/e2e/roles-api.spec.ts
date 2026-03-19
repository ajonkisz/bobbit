/**
 * E2E tests for the Role Management REST API.
 *
 * These tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify CRUD operations for /api/roles and the /api/tools endpoint.
 */
import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://127.0.0.1:3099";
const TOKEN = readFileSync(join(homedir(), ".pi", "gateway-token"), "utf-8").trim();
const ROLES_FILE = join(homedir(), ".pi", "gateway-roles.json");

/** Helper: authenticated fetch */
function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

// Back up and restore roles file around the test suite so we don't corrupt real data
let rolesBackup: string | null = null;

test.beforeAll(() => {
	if (existsSync(ROLES_FILE)) {
		rolesBackup = readFileSync(ROLES_FILE, "utf-8");
	}
});

test.afterAll(() => {
	// Restore original roles file (or remove if it didn't exist)
	if (rolesBackup !== null) {
		writeFileSync(ROLES_FILE, rolesBackup, "utf-8");
	} else {
		try { unlinkSync(ROLES_FILE); } catch { /* ignore */ }
	}
});

// Clean up any test roles after each test
test.afterEach(async () => {
	// Remove test roles that may have been created
	for (const name of ["test-role", "another-role", "a", "my-role-123"]) {
		await apiFetch(`/api/roles/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

test.describe("GET /api/roles — default roles", () => {
	test("returns seeded default roles on fresh start", async () => {
		const resp = await apiFetch("/api/roles");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.roles).toBeDefined();
		expect(Array.isArray(data.roles)).toBe(true);

		const names = data.roles.map((r: any) => r.name);
		expect(names).toContain("team-lead");
		expect(names).toContain("coder");
		expect(names).toContain("reviewer");
		expect(names).toContain("tester");
	});

	test("default roles have expected accessories", async () => {
		const resp = await apiFetch("/api/roles");
		const { roles } = await resp.json();
		const byName = Object.fromEntries(roles.map((r: any) => [r.name, r]));

		expect(byName["team-lead"].accessory).toBe("crown");
		expect(byName["coder"].accessory).toBe("bandana");
		expect(byName["reviewer"].accessory).toBe("magnifier");
		expect(byName["tester"].accessory).toBe("goggles");
	});

	test("default roles have labels and prompt templates", async () => {
		const resp = await apiFetch("/api/roles");
		const { roles } = await resp.json();

		for (const role of roles) {
			expect(role.label).toBeTruthy();
			expect(typeof role.label).toBe("string");
			expect(typeof role.promptTemplate).toBe("string");
			expect(role.promptTemplate.length).toBeGreaterThan(0);
			expect(Array.isArray(role.allowedTools)).toBe(true);
		}
	});
});

test.describe("POST /api/roles — create", () => {
	test("creates a new role with valid data", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "test-role",
				label: "Test Role",
				promptTemplate: "You are a test role.",
				allowedTools: ["Read", "Write"],
				accessory: "glasses",
			}),
		});
		expect(resp.status).toBe(201);
		const role = await resp.json();
		expect(role.name).toBe("test-role");
		expect(role.label).toBe("Test Role");
		expect(role.promptTemplate).toBe("You are a test role.");
		expect(role.allowedTools).toEqual(["Read", "Write"]);
		expect(role.accessory).toBe("glasses");
		expect(role.createdAt).toBeDefined();
		expect(role.updatedAt).toBeDefined();
	});

	test("rejects duplicate role names", async () => {
		// Create first
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "First" }),
		});

		// Attempt duplicate
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "Second" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("already exists");
	});

	test("rejects role name with uppercase letters", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "TestRole", label: "Bad Name" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});

	test("rejects role name with spaces", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test role", label: "Bad Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects role name with special characters", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test_role!", label: "Bad Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing role name", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ label: "No Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing label", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role" }),
		});
		expect(resp.status).toBe(400);
	});

	test("accepts single-character role name", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "a", label: "Single Char" }),
		});
		expect(resp.status).toBe(201);
	});

	test("accepts alphanumeric with hyphens", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "my-role-123", label: "Valid Name" }),
		});
		expect(resp.status).toBe(201);
	});

	test("defaults accessory to 'none' and allowedTools to empty array", async () => {
		const resp = await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "Defaults Test" }),
		});
		expect(resp.status).toBe(201);
		const role = await resp.json();
		expect(role.accessory).toBe("none");
		expect(role.allowedTools).toEqual([]);
	});
});

test.describe("GET /api/roles/:name — get single role", () => {
	test("returns an existing role", async () => {
		const resp = await apiFetch("/api/roles/team-lead");
		expect(resp.status).toBe(200);
		const role = await resp.json();
		expect(role.name).toBe("team-lead");
		expect(role.label).toBe("Team Lead");
		expect(role.accessory).toBe("crown");
	});

	test("returns 404 for non-existent role", async () => {
		const resp = await apiFetch("/api/roles/nonexistent-role");
		expect(resp.status).toBe(404);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});
});

test.describe("PUT /api/roles/:name — update", () => {
	test("updates role label", async () => {
		// Create a role first
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "Original" }),
		});

		const resp = await apiFetch("/api/roles/test-role", {
			method: "PUT",
			body: JSON.stringify({ label: "Updated Label" }),
		});
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);

		// Verify the update persisted
		const getResp = await apiFetch("/api/roles/test-role");
		const role = await getResp.json();
		expect(role.label).toBe("Updated Label");
	});

	test("updates promptTemplate and allowedTools", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "Test" }),
		});

		await apiFetch("/api/roles/test-role", {
			method: "PUT",
			body: JSON.stringify({
				promptTemplate: "Updated prompt",
				allowedTools: ["Bash", "Read"],
			}),
		});

		const getResp = await apiFetch("/api/roles/test-role");
		const role = await getResp.json();
		expect(role.promptTemplate).toBe("Updated prompt");
		expect(role.allowedTools).toEqual(["Bash", "Read"]);
	});

	test("updates accessory", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "Test", accessory: "none" }),
		});

		await apiFetch("/api/roles/test-role", {
			method: "PUT",
			body: JSON.stringify({ accessory: "shield" }),
		});

		const getResp = await apiFetch("/api/roles/test-role");
		const role = await getResp.json();
		expect(role.accessory).toBe("shield");
	});

	test("returns 404 when updating non-existent role", async () => {
		const resp = await apiFetch("/api/roles/nonexistent-role", {
			method: "PUT",
			body: JSON.stringify({ label: "Nope" }),
		});
		expect(resp.status).toBe(404);
	});
});

test.describe("DELETE /api/roles/:name", () => {
	test("deletes an existing role", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({ name: "test-role", label: "To Delete" }),
		});

		const resp = await apiFetch("/api/roles/test-role", { method: "DELETE" });
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);

		// Verify it's gone
		const getResp = await apiFetch("/api/roles/test-role");
		expect(getResp.status).toBe(404);
	});

	test("returns 404 when deleting non-existent role", async () => {
		const resp = await apiFetch("/api/roles/nonexistent-role", { method: "DELETE" });
		expect(resp.status).toBe(404);
	});

	test("can delete a default role", async () => {
		// Default roles should be deletable (per spec: "no special status")
		const resp = await apiFetch("/api/roles/tester", { method: "DELETE" });
		expect(resp.status).toBe(200);

		const getResp = await apiFetch("/api/roles/tester");
		expect(getResp.status).toBe(404);

		// Re-create it so other tests aren't affected
		// (The afterAll will restore the roles file anyway)
	});
});

test.describe("GET /api/tools", () => {
	test("returns available tools list", async () => {
		const resp = await apiFetch("/api/tools");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.tools).toBeDefined();
		expect(Array.isArray(data.tools)).toBe(true);
		expect(data.tools.length).toBeGreaterThan(0);
	});

	test("includes expected tool names", async () => {
		const resp = await apiFetch("/api/tools");
		const { tools } = await resp.json();
		expect(tools).toContain("Read");
		expect(tools).toContain("Write");
		expect(tools).toContain("Edit");
		expect(tools).toContain("Bash");
		expect(tools).toContain("web_search");
		expect(tools).toContain("web_fetch");
		expect(tools).toContain("delegate");
		// "workflow" tool was removed and replaced by the skills system
	});
});

test.describe("Role persistence", () => {
	test("created role appears in subsequent GET /api/roles", async () => {
		await apiFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify({
				name: "test-role",
				label: "Persistent Role",
				promptTemplate: "Test prompt",
				allowedTools: ["Bash"],
				accessory: "pencil",
			}),
		});

		const resp = await apiFetch("/api/roles");
		const { roles } = await resp.json();
		const names = roles.map((r: any) => r.name);
		expect(names).toContain("test-role");

		const created = roles.find((r: any) => r.name === "test-role");
		expect(created.label).toBe("Persistent Role");
		expect(created.promptTemplate).toBe("Test prompt");
		expect(created.allowedTools).toEqual(["Bash"]);
		expect(created.accessory).toBe("pencil");
	});
});

test.describe("Auth required", () => {
	test("rejects unauthenticated requests to /api/roles", async () => {
		const resp = await fetch(`${BASE}/api/roles`);
		expect(resp.status).toBe(401);
	});

	test("rejects unauthenticated requests to /api/tools", async () => {
		const resp = await fetch(`${BASE}/api/tools`);
		expect(resp.status).toBe(401);
	});
});
