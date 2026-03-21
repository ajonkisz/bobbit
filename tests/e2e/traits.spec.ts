/**
 * E2E tests for the Personality Traits REST API.
 *
 * These tests run against a real gateway (started by Playwright webServer on port 3099).
 * They verify CRUD operations for /api/traits and traits integration with sessions.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, mkdirSync, copyFileSync, unlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readE2EToken } from "./e2e-setup.js";

const BASE = "http://127.0.0.1:3099";
const TOKEN = readE2EToken();
const TRAITS_DIR = resolve(process.cwd(), "traits");
const TRAITS_BACKUP_DIR = resolve(process.cwd(), "traits-backup-e2e");

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

// Back up and restore YAML trait files around the test suite
test.beforeAll(() => {
	mkdirSync(TRAITS_BACKUP_DIR, { recursive: true });
	if (existsSync(TRAITS_DIR)) {
		for (const f of readdirSync(TRAITS_DIR).filter(f => f.endsWith(".yaml"))) {
			copyFileSync(join(TRAITS_DIR, f), join(TRAITS_BACKUP_DIR, f));
		}
	}
});

test.afterAll(() => {
	if (existsSync(TRAITS_BACKUP_DIR)) {
		if (existsSync(TRAITS_DIR)) {
			for (const f of readdirSync(TRAITS_DIR).filter(f => f.endsWith(".yaml"))) {
				unlinkSync(join(TRAITS_DIR, f));
			}
		}
		for (const f of readdirSync(TRAITS_BACKUP_DIR).filter(f => f.endsWith(".yaml"))) {
			copyFileSync(join(TRAITS_BACKUP_DIR, f), join(TRAITS_DIR, f));
		}
		rmSync(TRAITS_BACKUP_DIR, { recursive: true, force: true });
	}
});

// Clean up test traits after each test
test.afterEach(async () => {
	for (const name of ["test-trait", "another-trait", "my-trait-123"]) {
		await apiFetch(`/api/traits/${name}`, { method: "DELETE" }).catch(() => {});
	}
});

// Run tests serially to avoid rate limiting
test.describe.configure({ mode: "serial" });

// ── GET /api/traits ──

test.describe("GET /api/traits — seed traits", () => {
	test("returns all 10 seed traits", async () => {
		const resp = await apiFetch("/api/traits");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.traits).toBeDefined();
		expect(Array.isArray(data.traits)).toBe(true);
		expect(data.traits.length).toBe(10);

		const names = data.traits.map((t: any) => t.name);
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

	test("seed traits have required fields", async () => {
		const resp = await apiFetch("/api/traits");
		const { traits } = await resp.json();
		for (const trait of traits) {
			expect(typeof trait.name).toBe("string");
			expect(trait.name.length).toBeGreaterThan(0);
			expect(typeof trait.label).toBe("string");
			expect(trait.label.length).toBeGreaterThan(0);
			expect(typeof trait.description).toBe("string");
			expect(typeof trait.promptFragment).toBe("string");
			expect(trait.promptFragment.length).toBeGreaterThan(0);
		}
	});
});

// ── GET /api/traits/:name ──

test.describe("GET /api/traits/:name — single trait", () => {
	test("returns correct trait for 'thorough'", async () => {
		const resp = await apiFetch("/api/traits/thorough");
		expect(resp.status).toBe(200);
		const trait = await resp.json();
		expect(trait.name).toBe("thorough");
		expect(trait.label).toBe("Thorough");
		expect(trait.promptFragment).toBeTruthy();
		expect(trait.description).toBeTruthy();
	});

	test("returns 404 for nonexistent trait", async () => {
		const resp = await apiFetch("/api/traits/nonexistent");
		expect(resp.status).toBe(404);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});
});

// ── POST /api/traits ──

test.describe("POST /api/traits — create", () => {
	test("creates a custom trait with valid data", async () => {
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({
				name: "test-trait",
				label: "Test Trait",
				description: "A trait for testing",
				promptFragment: "Be extra testy.",
			}),
		});
		expect(resp.status).toBe(201);
		const trait = await resp.json();
		expect(trait.name).toBe("test-trait");
		expect(trait.label).toBe("Test Trait");
		expect(trait.description).toBe("A trait for testing");
		expect(trait.promptFragment).toBe("Be extra testy.");
		expect(trait.createdAt).toBeDefined();
		expect(trait.updatedAt).toBeDefined();
	});

	test("rejects duplicate trait name", async () => {
		// Create first
		await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "test-trait", label: "First" }),
		});
		// Attempt duplicate
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "test-trait", label: "Second" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("already exists");
	});

	test("rejects name with uppercase letters", async () => {
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "TestTrait", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toBeTruthy();
	});

	test("rejects name with spaces", async () => {
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "test trait", label: "Bad" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing name", async () => {
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ label: "No Name" }),
		});
		expect(resp.status).toBe(400);
	});

	test("rejects missing label", async () => {
		const resp = await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "test-trait" }),
		});
		expect(resp.status).toBe(400);
	});
});

// ── PUT /api/traits/:name ──

test.describe("PUT /api/traits/:name — update", () => {
	test("updates a trait's label and description", async () => {
		// Create first
		await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({
				name: "test-trait",
				label: "Original",
				description: "Original desc",
				promptFragment: "Original prompt.",
			}),
		});

		const resp = await apiFetch("/api/traits/test-trait", {
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
		const getResp = await apiFetch("/api/traits/test-trait");
		const trait = await getResp.json();
		expect(trait.label).toBe("Updated Label");
		expect(trait.description).toBe("Updated desc");
		// promptFragment should be unchanged
		expect(trait.promptFragment).toBe("Original prompt.");
	});

	test("returns 404 when updating nonexistent trait", async () => {
		const resp = await apiFetch("/api/traits/nonexistent", {
			method: "PUT",
			body: JSON.stringify({ label: "Nope" }),
		});
		expect(resp.status).toBe(404);
	});
});

// ── DELETE /api/traits/:name ──

test.describe("DELETE /api/traits/:name", () => {
	test("deletes an existing trait", async () => {
		await apiFetch("/api/traits", {
			method: "POST",
			body: JSON.stringify({ name: "test-trait", label: "To Delete" }),
		});

		const resp = await apiFetch("/api/traits/test-trait", { method: "DELETE" });
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.ok).toBe(true);

		// Verify it's gone
		const getResp = await apiFetch("/api/traits/test-trait");
		expect(getResp.status).toBe(404);
	});

	test("returns 404 when deleting nonexistent trait", async () => {
		const resp = await apiFetch("/api/traits/nonexistent", { method: "DELETE" });
		expect(resp.status).toBe(404);
	});
});

// ── Session integration ──

test.describe("Session + traits integration", () => {
	const sessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of sessionIds.splice(0)) {
			await deleteSession(id);
		}
	});

	test("POST /api/sessions with traits creates session with traits", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: process.cwd(),
				traits: ["thorough", "creative"],
			}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		sessionIds.push(data.id);
		expect(data.traits).toBeDefined();
		expect(Array.isArray(data.traits)).toBe(true);
		expect(data.traits).toContain("thorough");
		expect(data.traits).toContain("creative");
	});

	test("GET /api/sessions includes traits in response", async () => {
		const id = await createSession({ traits: ["terse"] });
		sessionIds.push(id);

		const resp = await apiFetch("/api/sessions");
		expect(resp.status).toBe(200);
		const { sessions } = await resp.json();
		const session = sessions.find((s: any) => s.id === id);
		expect(session).toBeDefined();
		expect(session.traits).toContain("terse");
	});

	test("GET /api/sessions/:id includes traits", async () => {
		const id = await createSession({ traits: ["creative", "direct"] });
		sessionIds.push(id);

		const resp = await apiFetch(`/api/sessions/${id}`);
		expect(resp.status).toBe(200);
		const session = await resp.json();
		expect(session.traits).toBeDefined();
		expect(session.traits).toContain("creative");
		expect(session.traits).toContain("direct");
	});

	test("PATCH /api/sessions/:id with traits updates session traits", async () => {
		const id = await createSession({ traits: ["thorough"] });
		sessionIds.push(id);

		const patchResp = await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ traits: ["creative", "terse"] }),
		});
		expect(patchResp.status).toBe(200);

		// Verify traits were updated
		const getResp = await apiFetch(`/api/sessions/${id}`);
		const session = await getResp.json();
		expect(session.traits).toContain("creative");
		expect(session.traits).toContain("terse");
		expect(session.traits).not.toContain("thorough");
	});

	test("PATCH /api/sessions/:id with invalid trait name returns 400", async () => {
		const id = await createSession();
		sessionIds.push(id);

		const resp = await apiFetch(`/api/sessions/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ traits: ["nonexistent-trait-xyz"] }),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown traits");
	});

	test("POST /api/sessions with invalid trait returns 400", async () => {
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: process.cwd(),
				traits: ["nonexistent-trait-xyz"],
			}),
		});
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Unknown traits");
	});
});
