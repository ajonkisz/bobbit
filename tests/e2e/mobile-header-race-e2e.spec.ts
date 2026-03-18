/**
 * E2E test: Mobile header appears immediately after connecting to a session.
 * Verifies the fix for the render race where the mobile header (including
 * Chat/Preview tabs for goal assistant sessions) didn't render on first connect.
 *
 * Uses Playwright webServer to start a sandboxed gateway on port 3098 with UI.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = "http://127.0.0.1:3098";
const TOKEN = readFileSync(join(homedir(), ".pi", "gateway-token"), "utf-8").trim();

/** Create a goal assistant session via REST */
async function createGoalAssistantSession(): Promise<string> {
	const resp = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ goalAssistant: true, cwd: process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = (await resp.json()) as { id: string };
	return data.id;
}

/** Create a regular session via REST */
async function createRegularSession(): Promise<string> {
	const resp = await fetch(`${BASE}/api/sessions`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	expect(resp.status).toBe(201);
	const data = (await resp.json()) as { id: string };
	return data.id;
}

/** Clean up a session */
async function deleteSession(id: string) {
	await fetch(`${BASE}/api/sessions/${id}`, {
		method: "DELETE",
		headers: { "Authorization": `Bearer ${TOKEN}` },
	});
}

test.describe("Mobile header race - E2E", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

	test("goal assistant session shows mobile header with Chat/Preview tabs", async ({ page }) => {
		const sessionId = await createGoalAssistantSession();

		try {
			// Inject localStorage BEFORE any page script runs
			await page.addInitScript(([url, token]) => {
				localStorage.setItem("gateway.url", url as string);
				localStorage.setItem("gateway.token", token as string);
			}, [BASE, TOKEN]);

			// Navigate directly to the session (hash format: #/session/{id})
			await page.goto(`${BASE}/#/session/${sessionId}`, { waitUntil: "domcontentloaded" });

			// Wait for the mobile header to appear.
			// Before the fix, this would time out because the header never rendered
			// on first connect (the race condition).
			const header = page.locator("#app-header");
			await expect(header).toBeVisible({ timeout: 20_000 });

			// Verify the goal assistant tab bar is present
			const tabBar = page.locator(".goal-tab-bar");
			await expect(tabBar).toBeVisible({ timeout: 5_000 });

			// Verify Chat and Preview tab pills exist
			await expect(page.locator(".goal-tab-pill").nth(0)).toContainText("Chat");
			await expect(page.locator(".goal-tab-pill").nth(1)).toContainText("Preview");
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("regular session shows mobile header with back button", async ({ page }) => {
		const sessionId = await createRegularSession();

		try {
			await page.addInitScript(([url, token]) => {
				localStorage.setItem("gateway.url", url as string);
				localStorage.setItem("gateway.token", token as string);
			}, [BASE, TOKEN]);

			await page.goto(`${BASE}/#/session/${sessionId}`, { waitUntil: "domcontentloaded" });

			// Mobile header must appear
			const header = page.locator("#app-header");
			await expect(header).toBeVisible({ timeout: 20_000 });

			// Should NOT have the goal tab bar
			await expect(page.locator(".goal-tab-bar")).toHaveCount(0);

			// Should have the back button
			await expect(header.locator("text=All Sessions")).toBeVisible();
		} finally {
			await deleteSession(sessionId);
		}
	});
});
