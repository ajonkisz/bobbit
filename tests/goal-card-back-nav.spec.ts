import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-card-back-nav.html")}#/`;

test.describe("Goal card back navigation", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // mobile

	test("clicking goal card header expands/collapses — does NOT navigate to dashboard", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#view-landing")).toHaveClass(/active/);

		// Sessions should be hidden initially
		await expect(page.locator("#goal-body-1")).toHaveClass(/hidden/);

		// Click goal header to expand
		await page.click("#goal-header-1");

		// Sessions should now be visible, still on landing
		await expect(page.locator("#goal-body-1")).not.toHaveClass(/hidden/);
		expect(await page.evaluate(() => window.location.hash)).toBe("#/");
		await expect(page.locator("#view-landing")).toHaveClass(/active/);

		// Click again to collapse
		await page.click("#goal-header-1");
		await expect(page.locator("#goal-body-1")).toHaveClass(/hidden/);
		expect(await page.evaluate(() => window.location.hash)).toBe("#/");
	});

	test("clicking session inside expanded goal card — navigates directly, browser back goes to landing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Expand goal
		await page.click("#goal-header-1");
		await expect(page.locator("#goal-body-1")).not.toHaveClass(/hidden/);

		// Click session card directly
		await page.click("#session-card-tl");
		await page.waitForFunction(() => window.location.hash.includes("session"));

		// Should be on session view
		await expect(page.locator("#view-session")).toHaveClass(/active/);

		// Browser back should go to landing (no goal-dashboard in history)
		await page.goBack();
		await page.waitForFunction(() => !window.location.hash.includes("session"), { timeout: 3000 });
		const hash = await page.evaluate(() => window.location.hash);

		expect(hash).toBe("#/");
		expect(hash).not.toContain("/goal/");
	});

	test("explicit dashboard button navigates to dashboard, session from there — back goes to landing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Expand goal and click dashboard button
		await page.click("#goal-header-1");
		await page.click("#dashboard-btn-1");

		await page.waitForFunction(() => window.location.hash.includes("goal"));
		await expect(page.locator("#view-goal-dashboard")).toHaveClass(/active/);

		// Click session from dashboard
		await page.click("#dashboard-session-tl");
		await page.waitForFunction(() => window.location.hash.includes("session"));
		await expect(page.locator("#view-session")).toHaveClass(/active/);

		// Browser back — should go to landing (dashboard entry replaced)
		await page.goBack();
		await page.waitForFunction(() => !window.location.hash.includes("session"), { timeout: 3000 });
		const hash = await page.evaluate(() => window.location.hash);

		expect(hash).toBe("#/");
		expect(hash).not.toContain("/goal/");
	});

	test("no goal-dashboard hash ever enters history when clicking sessions from landing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Track all hash changes
		await page.evaluate(() => {
			(window as any).__hashHistory = [];
			window.addEventListener("hashchange", () => {
				(window as any).__hashHistory.push(window.location.hash);
			});
		});

		// Expand goal, click session
		await page.click("#goal-header-1");
		await page.click("#session-card-tl");
		await page.waitForFunction(() => window.location.hash.includes("session"));

		// Check no goal-dashboard hash was ever set
		const hashHistory = await page.evaluate(() => (window as any).__hashHistory);
		const goalDashboardEntries = hashHistory.filter((h: string) => h.includes("/goal/"));
		expect(goalDashboardEntries).toHaveLength(0);
	});
});
