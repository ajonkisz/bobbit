import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-header.html")}`;

/**
 * Helper: scroll #scroll-target to a given position.
 *
 * Programmatic `el.scrollTop = N` does NOT reliably fire scroll events in
 * headless Chromium. The test page exposes `window.__scrollTo(top)` which
 * sets scrollTop AND dispatches a scroll event so the capture-phase handler
 * always runs.
 */
async function scrollTo(page: any, top: number) {
	await page.evaluate((t: number) => (window as any).__scrollTo(t), top);
}

test.describe("Mobile header auto-hide", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE size

	test("scroll container exists and is scrollable", async ({ page }) => {
		await page.goto(TEST_PAGE);
		
		const scrollEl = page.locator("#scroll-target");
		await expect(scrollEl).toBeVisible();

		const scrollInfo = await scrollEl.evaluate((el: Element) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			isScrollable: el.scrollHeight > el.clientHeight,
		}));
		
		expect(scrollInfo.isScrollable).toBe(true);
		console.log("Scroll info:", scrollInfo);
	});

	test("header is visible initially", async ({ page }) => {
		await page.goto(TEST_PAGE);
		
		const header = page.locator("#app-header");
		await expect(header).toBeVisible();

		const transform = await header.evaluate(
			(el: Element) => getComputedStyle(el).transform
		);
		// "none" or "matrix(1, 0, 0, 1, 0, 0)" means translateY(0)
		expect(transform === "none" || transform.endsWith(", 0)")).toBe(true);
	});

	test("header hides when scrolling down", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		// Scroll down significantly
		await scrollTo(page, 300);
		
		// Wait for scroll handler to update state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		const header = page.locator("#app-header");
		const transform = await header.evaluate(
			(el: HTMLElement) => el.style.transform
		);
		expect(transform).toBe("translateY(-100%)");
	});

	test("header shows when scrolling back up", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		// First scroll down
		await scrollTo(page, 300);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Now scroll up a bit
		await scrollTo(page, 250);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });

		const header = page.locator("#app-header");
		const transform = await header.evaluate(
			(el: HTMLElement) => el.style.transform
		);
		expect(transform).toMatch(/translateY\(0(px)?\)/);
	});

	test("header always visible near top", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		// Scroll down then back near top
		await scrollTo(page, 300);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });
		await scrollTo(page, 10);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });
	});

	test("header hides/shows with touch-like scrolling", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const header = page.locator("#app-header");

		// Simulate finger scrolling down with multiple small increments
		for (let i = 1; i <= 10; i++) {
			await scrollTo(page, i * 30);
		}

		// Wait for hidden state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Simulate finger scrolling up
		for (let i = 0; i < 5; i++) {
			await page.evaluate((offset: number) => {
				const el = document.getElementById("scroll-target")!;
				(window as any).__scrollTo(el.scrollTop - offset);
			}, 20);
		}

		// Wait for visible state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });

		// Verify transform is applied
		const transform = await header.evaluate((el: HTMLElement) => el.style.transform);
		expect(transform).toMatch(/translateY\(0(px)?\)/);
	});

	test("capture-phase listener works even with deeply nested scroll containers", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		// Scroll down
		await scrollTo(page, 300);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Scroll up
		await scrollTo(page, 250);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });
	});

	test("padding-top is set on app-main", async ({ page }) => {
		await page.goto(TEST_PAGE);
		
		const paddingTop = await page.locator("#app-main").evaluate(
			(el: HTMLElement) => el.style.paddingTop
		);
		expect(paddingTop).not.toBe("");
		expect(parseInt(paddingTop)).toBeGreaterThan(0);
	});
});
