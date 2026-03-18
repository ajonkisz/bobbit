import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/draft-persistence.html")}`;

test.describe("Draft persistence", () => {
	test("saves draft to sessionStorage after debounce", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.fill("#editor", "hello world");
		// Wait for 100ms debounce + margin
		await page.waitForTimeout(200);

		const stored = await page.evaluate(() =>
			sessionStorage.getItem("bobbit_draft_session-A")
		);
		expect(stored).toBe("hello world");
	});

	test("restores draft on page reload", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.fill("#editor", "persisted text");
		await page.waitForTimeout(200);

		// Reload — draft should be restored
		await page.reload();
		const val = await page.inputValue("#editor");
		expect(val).toBe("persisted text");
	});

	test("send clears draft from sessionStorage and textarea", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.fill("#editor", "will be sent");
		await page.waitForTimeout(200);

		await page.click("#send-btn");

		const val = await page.inputValue("#editor");
		expect(val).toBe("");

		const stored = await page.evaluate(() =>
			sessionStorage.getItem("bobbit_draft_session-A")
		);
		expect(stored).toBeNull();
	});

	test("switching sessions restores correct draft", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Set draft for session A
		await page.fill("#editor", "draft A");
		await page.waitForTimeout(200);

		// Switch to session B
		await page.fill("#session-id", "session-B");
		await page.dispatchEvent("#session-id", "change");

		// Type draft for session B
		await page.fill("#editor", "draft B");
		await page.waitForTimeout(200);

		// Switch back to session A
		await page.fill("#session-id", "session-A");
		await page.dispatchEvent("#session-id", "change");

		const val = await page.inputValue("#editor");
		expect(val).toBe("draft A");

		// Verify session B's draft is still stored
		const storedB = await page.evaluate(() =>
			sessionStorage.getItem("bobbit_draft_session-B")
		);
		expect(storedB).toBe("draft B");
	});
});
