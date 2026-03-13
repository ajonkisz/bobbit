import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for session auto-rename and manual rename with
 * the magic "generate title" wand button.
 *
 * Requires the gateway + vite dev server to be running:
 *   VITE_HOST=localhost node dist/server/cli.js --host localhost --cwd . --no-ui &
 *   VITE_HOST=localhost npx vite --port 5174
 *
 * Or simply:
 *   npx playwright test tests/session-rename.spec.ts --config tests/playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readGatewayToken(): string {
	const tokenPath = path.join(os.homedir(), ".pi", "gateway-token");
	const token = fs.readFileSync(tokenPath, "utf-8").trim();
	if (!token || token.length < 64) throw new Error("No valid gateway token found");
	return token;
}

/** Navigate to the app with the auth token so it auto-authenticates. */
async function openApp(page: Page, token: string) {
	await page.goto(`/?token=${encodeURIComponent(token)}`);
	// Wait until the authenticated UI appears (sidebar with "Sessions" heading)
	await expect(page.getByText("Sessions", { exact: true })).toBeVisible({ timeout: 15_000 });
}

/** Click the "+ New session" button in the sidebar and wait for the editor. */
async function createNewSession(page: Page) {
	await page.locator('button[title="New session"]').click();
	// Wait for the message editor textarea to appear (means session is connected)
	await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });
}

/** Type a message into the editor and send it. */
async function sendMessage(page: Page, text: string) {
	const textarea = page.locator("message-editor textarea");
	await textarea.fill(text);
	// Press Enter to send (the editor sends on Enter)
	await textarea.press("Enter");
}

/** Wait for the agent to finish streaming (the send button reappears / spinner gone). */
async function waitForAgentIdle(page: Page, timeout = 120_000) {
	// The agent is streaming while there is a stop/square button visible.
	// Once it finishes, the send button (rotated plane icon) comes back.
	// We detect idle by waiting for the "streaming" status dot to disappear
	// from the sidebar — or simply wait for the textarea to be enabled again.
	// Most reliable: wait for the assistant message to fully render.
	await page.waitForFunction(
		() => {
			// RemoteAgent sets state.isStreaming = false on agent_end.
			// The message-editor re-enables the textarea when not streaming.
			const ta = document.querySelector("message-editor textarea") as HTMLTextAreaElement | null;
			return ta && !ta.disabled;
		},
		{ timeout },
	);
	// Small extra pause for title generation (fires async after agent_end)
	await page.waitForTimeout(1_000);
}

/** Get the title text shown in the sidebar for the currently active session. */
async function getActiveSessionTitle(page: Page): Promise<string> {
	// The active session row has bg-secondary class. Its title is in a .truncate div.
	const activeRow = page.locator(".bg-secondary .truncate.text-xs").first();
	await expect(activeRow).toBeVisible({ timeout: 5_000 });
	return (await activeRow.textContent())?.trim() || "";
}

/**
 * Wait until the active session's sidebar title changes away from the initial
 * value ("New session") to something else, with a timeout.
 */
async function waitForTitleChange(
	page: Page,
	notExpected: string = "New session",
	timeout: number = 30_000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const title = await getActiveSessionTitle(page);
		if (title && title !== notExpected) return title;
		await page.waitForTimeout(500);
	}
	throw new Error(`Title did not change from "${notExpected}" within ${timeout}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Session rename", () => {
	// These tests make real LLM calls — give them plenty of time
	test.setTimeout(180_000);

	let token: string;

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test("auto-renames session after first message about weather", async ({ page }) => {
		await openApp(page, token);
		await createNewSession(page);

		// Verify initial title
		const initialTitle = await getActiveSessionTitle(page);
		expect(initialTitle).toBe("New session");

		// Send a weather-related message
		await sendMessage(page, "What is the weather like in London today?");
		await waitForAgentIdle(page);

		// The server auto-generates a title after the first agent turn.
		// Wait for it to propagate to the sidebar.
		const newTitle = await waitForTitleChange(page, "New session", 30_000);

		console.log(`Auto-generated title: "${newTitle}"`);

		// The title should relate to weather / London
		const lower = newTitle.toLowerCase();
		const weatherRelated =
			lower.includes("weather") ||
			lower.includes("london") ||
			lower.includes("forecast") ||
			lower.includes("climate") ||
			lower.includes("temperature");
		expect(weatherRelated).toBe(true);
	});

	test("manual rename via magic wand regenerates title from full history", async ({ page }) => {
		await openApp(page, token);
		await createNewSession(page);

		// 1) Send initial weather message
		await sendMessage(page, "What is the weather like in London today?");
		await waitForAgentIdle(page);

		// Wait for the initial auto-title
		await waitForTitleChange(page, "New session", 30_000);
		const firstTitle = await getActiveSessionTitle(page);
		console.log(`First auto-title: "${firstTitle}"`);

		// 2) Send a follow-up that shifts the topic to tents
		await sendMessage(
			page,
			'Sorry, I actually meant to ask about "Weather Proof Tents" — what are the best waterproof tents for camping in heavy rain?',
		);
		await waitForAgentIdle(page);

		// 3) Click the rename (pencil) button on the active session in the sidebar
		// The active session row has the bg-secondary class. The rename button
		// appears on hover with title="Rename session".
		const activeRow = page.locator(".bg-secondary").first();
		await activeRow.hover();
		const renameBtn = activeRow.locator('button[title="Rename session"]');
		await expect(renameBtn).toBeVisible({ timeout: 5_000 });
		await renameBtn.click();

		// 4) The rename dialog should appear — target the dialog box itself (not the backdrop)
		const dialog = page.locator(".fixed.z-50.bg-background").filter({ hasText: "Rename Session" });
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		// 5) Click the magic wand button (auto-generate title)
		const wandBtn = dialog.locator('button[title="Auto-generate title from chat history"]');
		await expect(wandBtn).toBeVisible();
		await wandBtn.click();

		// Wait for the spinner to appear and then disappear (title generated)
		// The button shows a spinning SVG while generating
		await expect(wandBtn.locator(".animate-spin")).toBeVisible({ timeout: 5_000 }).catch(() => {
			// Spinner might have already gone if generation was fast
		});
		// Wait for spinner to disappear (generation complete)
		await expect(wandBtn.locator(".animate-spin")).not.toBeVisible({ timeout: 30_000 });

		// 6) The input should now contain the new generated title
		const titleInput = dialog.locator("input");
		await expect(titleInput).toBeVisible();
		const generatedTitle = await titleInput.inputValue();
		console.log(`Wand-generated title: "${generatedTitle}"`);

		// 7) Click the Rename button to confirm
		const confirmBtn = dialog.getByRole("button", { name: "Rename" });
		await confirmBtn.click();

		// 8) Dialog should close
		await expect(dialog).not.toBeVisible({ timeout: 5_000 });

		// 9) Wait for the sidebar title to update
		await page.waitForTimeout(1_000);
		const finalTitle = await getActiveSessionTitle(page);
		console.log(`Final sidebar title: "${finalTitle}"`);

		// The title should be about tents / waterproof / camping, NOT just "weather"
		const lower = finalTitle.toLowerCase();
		const tentRelated =
			lower.includes("tent") ||
			lower.includes("camp") ||
			lower.includes("waterproof") ||
			lower.includes("weather proof") ||
			lower.includes("weatherproof") ||
			lower.includes("rain");
		expect(tentRelated).toBe(true);
	});
});
