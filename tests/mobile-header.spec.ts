import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-header.html")}`;

test.describe("Mobile header auto-hide", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // iPhone SE size

	test("scroll container exists and is scrollable", async ({ page }) => {
		await page.goto(TEST_PAGE);
		
		const scrollEl = page.locator("#scroll-target");
		await expect(scrollEl).toBeVisible();

		const scrollInfo = await scrollEl.evaluate((el) => ({
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
			(el) => getComputedStyle(el).transform
		);
		// "none" or "matrix(1, 0, 0, 1, 0, 0)" means translateY(0)
		expect(transform === "none" || transform.endsWith(", 0)")).toBe(true);
	});

	test("header hides when scrolling down", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const scrollEl = page.locator("#scroll-target");
		
		// Scroll down significantly
		await scrollEl.evaluate((el) => {
			el.scrollTop = 300;
		});
		
		// Wait for scroll handler to update state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		const header = page.locator("#app-header");
		const transform = await header.evaluate(
			(el) => el.style.transform
		);
		expect(transform).toBe("translateY(-100%)");
	});

	test("header shows when scrolling back up", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const scrollEl = page.locator("#scroll-target");

		// First scroll down
		await scrollEl.evaluate((el) => {
			el.scrollTop = 300;
		});
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Now scroll up a bit
		await scrollEl.evaluate((el) => {
			el.scrollTop = 250;
		});
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });

		const header = page.locator("#app-header");
		const transform = await header.evaluate(
			(el) => el.style.transform
		);
		expect(transform).toMatch(/translateY\(0(px)?\)/);
	});

	test("header always visible near top", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const scrollEl = page.locator("#scroll-target");

		// Scroll down then back near top
		await scrollEl.evaluate((el) => { el.scrollTop = 300; });
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });
		await scrollEl.evaluate((el) => { el.scrollTop = 10; });
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });
	});

	test("header hides/shows with touch-like scrolling", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const scrollEl = page.locator("#scroll-target");
		const header = page.locator("#app-header");

		// Simulate finger scrolling down with multiple small increments
		for (let i = 0; i < 10; i++) {
			await scrollEl.evaluate((el) => {
				el.scrollTop += 30;
			});
			await page.waitForTimeout(20);
		}

		// Wait for hidden state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Simulate finger scrolling up
		for (let i = 0; i < 5; i++) {
			await scrollEl.evaluate((el) => {
				el.scrollTop -= 20;
			});
			await page.waitForTimeout(20);
		}

		// Wait for visible state
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });

		// Verify transform is applied
		const transform = await header.evaluate((el) => el.style.transform);
		expect(transform).toMatch(/translateY\(0(px)?\)/);
	});

	test("capture-phase listener works even with deeply nested scroll containers", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible !== undefined);

		const scrollEl = page.locator("#scroll-target");

		// Scroll down
		await scrollEl.evaluate((el) => { el.scrollTop = 300; });
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === false, null, { timeout: 2000 });

		// Scroll up
		await scrollEl.evaluate((el) => { el.scrollTop = 250; });
		await page.waitForFunction(() => (window as any).__mobileHeaderVisible() === true, null, { timeout: 2000 });
	});

	test("padding-top is set on app-main", async ({ page }) => {
		await page.goto(TEST_PAGE);
		
		const paddingTop = await page.locator("#app-main").evaluate(
			(el) => el.style.paddingTop
		);
		expect(paddingTop).not.toBe("");
		expect(parseInt(paddingTop)).toBeGreaterThan(0);
	});
});
