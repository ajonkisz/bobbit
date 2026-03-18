import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-header-race.html")}`;

test.describe("Mobile header render race", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE

	test("header is absent before connection", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#app-header")).toHaveCount(0);
		await expect(page.locator(".landing-page")).toBeVisible();
	});

	test("header appears immediately after connection (fixed flow)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Verify we start on the landing page
		await expect(page.locator("#app-header")).toHaveCount(0);

		// Simulate connection with the fixed flow
		await page.evaluate(() => (window as any).__simulateConnect());

		// Header must be present
		const header = page.locator("#app-header");
		await expect(header).toBeVisible();
		// translateY(0) computes to matrix(1, 0, 0, 1, 0, 0)
		const transform = await header.evaluate((el: Element) => getComputedStyle(el).transform);
		expect(transform === "none" || transform.endsWith(", 0)")).toBe(true);
	});

	test("goal assistant tab bar appears for goal assistant sessions", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() =>
			(window as any).__simulateConnect({ isGoalAssistant: true }),
		);

		// Header must have the goal tab bar
		await expect(page.locator("#app-header")).toBeVisible();
		await expect(page.locator(".goal-tab-bar")).toBeVisible();

		// Both Chat and Preview tabs must be present
		const tabs = page.locator(".goal-tab-pill");
		await expect(tabs).toHaveCount(2);
		await expect(tabs.nth(0)).toHaveText("Chat");
		await expect(tabs.nth(1)).toHaveText("Preview");
	});

	test("no goal tab bar for regular sessions", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() =>
			(window as any).__simulateConnect({ isGoalAssistant: false }),
		);

		await expect(page.locator("#app-header")).toBeVisible();
		await expect(page.locator(".goal-tab-bar")).toHaveCount(0);
	});

	test("header renders with correct state after full connect lifecycle", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Run the fixed flow and check render count
		await page.evaluate(() => (window as any).__resetRenderCount());
		await page.evaluate(() => (window as any).__simulateConnect());

		// Should have rendered at least 3 times:
		// 1. Initial disconnected render
		// 2. Immediate post-connect render (the fix)
		// 3. Finally block render
		const count = await page.evaluate(() => (window as any).__getRenderCount());
		expect(count).toBeGreaterThanOrEqual(3);

		// Header must be present after the full lifecycle
		await expect(page.locator("#app-header")).toBeVisible();
	});

	test("broken flow: header eventually appears but goal tab bar may be wrong", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// The broken flow sets isGoalAssistantSession LATE.
		// Even though the finally block calls renderApp(), the intermediate
		// renders (if any triggered by callbacks) wouldn't have the tab bar.
		await page.evaluate(() =>
			(window as any).__simulateConnectBroken({ isGoalAssistant: true }),
		);

		// After finally, the header IS present (the broken flow does render in finally)
		await expect(page.locator("#app-header")).toBeVisible();
		// And the tab bar is present because finally happens after isGoalAssistant is set
		await expect(page.locator(".goal-tab-bar")).toBeVisible();
	});

	test("transition from disconnected to connected re-renders correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Start disconnected
		await expect(page.locator(".landing-page")).toBeVisible();

		// Connect
		await page.evaluate(() => (window as any).__simulateConnect());
		await expect(page.locator("#app-header")).toBeVisible();
		await expect(page.locator(".landing-page")).toHaveCount(0);

		// Disconnect
		await page.evaluate(() => {
			const s = (window as any).__state;
			s.remoteAgent = null;
			s.connectionStatus = "disconnected";
			(window as any).__doRenderApp();
		});
		await expect(page.locator("#app-header")).toHaveCount(0);
		await expect(page.locator(".landing-page")).toBeVisible();

		// Reconnect as goal assistant
		await page.evaluate(() =>
			(window as any).__simulateConnect({ isGoalAssistant: true }),
		);
		await expect(page.locator("#app-header")).toBeVisible();
		await expect(page.locator(".goal-tab-bar")).toBeVisible();
	});
});
