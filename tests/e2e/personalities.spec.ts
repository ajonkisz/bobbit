/**
 * E2E tests for the Personalities REST API.
 *
 * These tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify CRUD operations for /api/personalities and personalities integration with sessions.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readE2EToken, BASE } from "./e2e-setup.js";
const TOKEN = readE2EToken();
const PERSONALITIES_DIR = resolve(process.cwd(), "personalities");
const PERSONALITIES_BACKUP_DIR = resolve(process.cwd(), "personalities-backup-e2e");

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

/** Helper: create a session, return its id */
async function createSession(extra: Record<string, unknown> = {}): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: process.cwd(), ...extra }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Helper: delete a session */
async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

// Back up and restore YAML personality files around the test suite
test.beforeAll(() => {
	mkdirSync(PERSONALITIES_BACKUP_DIR, { recursive: true });
	if (existsSync(PERSONALITIES_DIR)) {
		for (const f of readdirSync(PERSONALITIES_DIR).filter(f => f.endsWith(".yaml"))) {
			copyFileSync(join(PERSONALITIES_DIR, f), join(PERSONALITIES_BACKUP_DIR, f));
		}
	}
});

test.afterAll(() => {
	if (existsSync(PERSONALITIES_BACKUP_DIR)) {
		if (existsSync(PERSONALITIES_DIR)) {
			for (const f of readdirSync(PERSONALITIES_DIR).filter(f => f.endsWith(".yaml"))) {
				unlinkSync(join(PERSONALITIES_DIR, f));
			}
		}
		for (const f of readdirSync(PERSONALITIES_BACKUP_DIR).filter(f => f.endsWith(".yaml"))) {
			copyFileSync(join(PERSONALITIES_BACKUP_DIR, f), join(PERSONALITIES_DIR, f));
		}
		rmSync(PERSONALITIES_BACKUP_DIR, { recursive: true, force: true });
	}
});

// Clean up test personalities after each test
test.afterEach(async () => {
	for (const name of ["test-personality", "another-personality", "my-personality-123"]) {
		await apiFetch(`/api/personalities/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

// Run tests serially to avoid rate limiting
test.describe.configure({ mode: "serial" });

// ── GET /api/personalities ──

test.describe("GET /api/personalities — seed personalities", () => {
	test("returns all 10 seed personalities", async () => {
		const resp = await apiFetch("/api/personalities");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.personalities).toBeDefined();
		expect(Array.isArray(data.personalities)).toBe(true);
		expect(data.personalities.length).toBe(10);

		const names = data.personalities.map((t: any) => t.name);
		expect(names).toContain("thorough");
		expect(names).toContain("creative");
		expect(names).toContain("terse");
		expect(names).toContain("verbose");
		expect(names).toContain("critical");
		expect(names).toContain("explorative");
		expect(names).toContain("pragmatic");
		expect(names).toContain("quick-worker");
		expect(names).toContain("rigid");
		expect(names).toContain("direct");
	});

	test("seed personalities have required fields", async () => {
		const resp = await apiFetch("/api/personalities");
		const { personalities } = await resp.json();
		for (const personality of personalities) {
			expect(typeof personality.name).toBe("string");
			expect(personality.name.length).toBeGreaterThan(0);
			expect(typeof personality.label).toBe("string");
			expect(personality.label.length).toBeGreaterThan(0);
			expect(typeof personality.description).toBe("string");
			expect(typeof personality.promptFragment).toBe("string");
			expect(personality.promptFragment.length).toBeGreaterThan(0);
		}
	});
});

// ── GET /api/personalities/:name ──

test.describe("GET /api/personalities/:name — single personality", () => {
	test("returns correct personality for 'thorough'", async () => {
		const resp = await apiFetch("/api/personalities/thorough");
		expect(resp.status).toBe(200);
		const personality = await resp.json();
		expect(personality.name).toBe("thorough");
		expect(personality.label).toBe("Thorough");
		expect(personality.promptFragment).toBeTruthy();
		expect(personality.description).toBeTruthy();
	});

	test("returns 404 for nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent");
		expect(resp.status).toBe(404);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});
});

// ── POST /api/personalities ──

test.describe("POST /api/personalities — create", () => {
	test("creates a custom personality with valid data", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({
				name: "test-personality",
				label: "Test Personality",
				description: "A personality for testing",
				promptFragment: "Be extra testy.",
			}),
		});
		expect(resp.status).toBe(201);
		const personality = await resp.json();
		expect(personality.name).toBe("test-personality");
		expect(personality.label).toBe("Test Personality");
		expect(personality.description).toBe("A personality for testing");
		expect(personality.promptFragment).toBe("Be extra testy.");
		expect(personality.createdAt).toBeDefined();
		expect(personality.updatedAt).toBeDefined();
	});

	test("rejects duplicate personality name", async () => {
		// Create first
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "First" }),
		});
		// Attempt duplicate
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "Second" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("already exists");
	});

	test("rejects name with uppercase letters", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "TestPersonality", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});

	test("rejects name with spaces", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test personality", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing name", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ label: "No Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing label", async () => {
		const resp = await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality" }),
		});
		expect(resp.status).toBe(400);
	});
});

// ── PUT /api/personalities/:name ──

test.describe("PUT /api/personalities/:name — update", () => {
	test("updates a personality's label and description", async () => {
		// Create first
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({
				name: "test-personality",
				label: "Original",
				description: "Original desc",
				promptFragment: "Original prompt.",
			}),
		});

		const resp = await apiFetch("/api/personalities/test-personality", {
			method: "PUT",
			body: JSON.stringify({
				label: "Updated Label",
				description: "Updated desc",
			}),
		});
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);

		// Verify the update persisted
		const getResp = await apiFetch("/api/personalities/test-personality");
		const personality = await getResp.json();
		expect(personality.label).toBe("Updated Label");
		expect(personality.description).toBe("Updated desc");
		// promptFragment should be unchanged
		expect(personality.promptFragment).toBe("Original prompt.");
	});

	test("returns 404 when updating nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent", {
			method: "PUT",
			body: JSON.stringify({ label: "Nope" }),
		});
		expect(resp.status).toBe(404);
	});
});

// ── DELETE /api/personalities/:name ──

test.describe("DELETE /api/personalities/:name", () => {
	test("deletes an existing personality", async () => {
		await apiFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify({ name: "test-personality", label: "To Delete" }),
		});

		const resp = await apiFetch("/api/personalities/test-personality", { method: "DELETE" });
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);

		// Verify it's gone
		const getResp = await apiFetch("/api/personalities/test-personality");
		expect(getResp.status).toBe(404);
	});

	test("returns 404 when deleting nonexistent personality", async () => {
		const resp = await apiFetch("/api/personalities/nonexistent", { method: "DELETE" });
		expect(resp.status).toBe(404);
	});
});

// ── Session integration ──

test.describe("Session + personalities integration", () => {
	const sessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id);
		}
	});

	test("POST /api/sessions with personalities creates session with personalities", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: process.cwd(),
				personalities: ["thorough", "creative"],
			}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessionIds.push(data.id);
		expect(data.personalities).toBeDefined();
		expect(Array.isArray(data.personalities)).toBe(true);
		expect(data.personalities).toContain("thorough");
		expect(data.personalities).toContain("creative");
	});

	test("GET /api/sessions includes personalities in response", async () => {
		const id = await createSession({ personalities: ["terse"] });
		sessionIds.push(id);

		const resp = await apiFetch("/api/sessions");
		expect(resp.status).toBe(200);
		const { sessions } = await resp.json();
		const session = sessions.find((s: any) => s.id === id);
		expect(session).toBeDefined();
		expect(session.personalities).toContain("terse");
	});

	test("GET /api/sessions/:id includes personalities", async () => {
		const id = await createSession({ personalities: ["creative", "direct"] });
		sessionIds.push(id);

		const resp = await apiFetch(`/api/sessions/${id}`);
		expect(resp.status).toBe(200);
		const session = await resp.json();
		expect(session.personalities).toBeDefined();
		expect(session.personalities).toContain("creative");
		expect(session.personalities).toContain("direct");
	});

	test("PATCH /api/sessions/:id with personalities updates session personalities", async () => {
		const id = await createSession({ personalities: ["thorough"] });
		sessionIds.push(id);

		const patchResp = await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ personalities: ["creative", "terse"] }),
		});
		expect(patchResp.status).toBe(200);

		// Verify personalities were updated
		const getResp = await apiFetch(`/api/sessions/${id}`);
		const session = await getResp.json();
		expect(session.personalities).toContain("creative");
		expect(session.personalities).toContain("terse");
		expect(session.personalities).not.toContain("thorough");
	});

	test("PATCH /api/sessions/:id with invalid personality name returns 400", async () => {
		const id = await createSession();
		sessionIds.push(id);

		const resp = await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ personalities: ["nonexistent-personality-xyz"] }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown personalities");
	});

	test("POST /api/sessions with invalid personality returns 400", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: process.cwd(),
				personalities: ["nonexistent-personality-xyz"],
			}),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown personalities");
	});
});
