import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

/**
 * Unit tests for the cron parser (fieldMatches + cronMatches) from staff-trigger-engine.ts.
 *
 * Uses a file:// fixture that inlines the parser functions.
 *
 * Run with:
 *   npx playwright test tests/cron-parser.spec.ts --config tests/playwright.config.ts
 */

const FIXTURE = "file://" + path.resolve("tests/fixtures/cron-parser.html").replace(/\\/g, "/");

test.describe("fieldMatches", () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		await page.goto(FIXTURE);
	});

	test.afterAll(async () => {
		await page.close();
	});

	test("* matches any value", async () => {
		for (const v of [0, 1, 15, 30, 59]) {
			expect(await page.evaluate(([f, val]) => (window as any).fieldMatches(f, val), ["*", v])).toBe(true);
		}
	});

	test("exact number matches only that value", async () => {
		expect(await page.evaluate(() => (window as any).fieldMatches("5", 5))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("5", 4))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("5", 6))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("0", 0))).toBe(true);
	});

	test("range N-M matches inclusive", async () => {
		expect(await page.evaluate(() => (window as any).fieldMatches("1-5", 0))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("1-5", 1))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1-5", 3))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1-5", 5))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1-5", 6))).toBe(false);
	});

	test("comma-separated list matches any element", async () => {
		expect(await page.evaluate(() => (window as any).fieldMatches("1,15,30", 1))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1,15,30", 15))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1,15,30", 30))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("1,15,30", 2))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("1,15,30", 0))).toBe(false);
	});

	test("*/N step matches multiples of N from 0", async () => {
		// */15 should match 0, 15, 30, 45
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 0))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 15))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 30))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 45))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 7))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("*/15", 1))).toBe(false);
	});

	test("*/5 matches all multiples of 5", async () => {
		const expected = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
		for (const v of expected) {
			expect(await page.evaluate(([f, val]) => (window as any).fieldMatches(f, val), ["*/5", v])).toBe(true);
		}
		for (const v of [1, 2, 3, 4, 6, 7, 8, 9, 11]) {
			expect(await page.evaluate(([f, val]) => (window as any).fieldMatches(f, val), ["*/5", v])).toBe(false);
		}
	});

	test("range with step N-M/S", async () => {
		// 10-20/3 should match 10, 13, 16, 19
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 10))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 13))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 16))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 19))).toBe(true);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 11))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 9))).toBe(false);
		expect(await page.evaluate(() => (window as any).fieldMatches("10-20/3", 21))).toBe(false);
	});
});

test.describe("cronMatches", () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		await page.goto(FIXTURE);
	});

	test.afterAll(async () => {
		await page.close();
	});

	// Helper: create a Date with specific values
	// month is 1-based (like cron), day-of-week is auto from the date
	function makeDate(year: number, month: number, day: number, hour: number, minute: number): string {
		// Return JS expression to create a Date inside the page
		return `new Date(${year}, ${month - 1}, ${day}, ${hour}, ${minute})`;
	}

	test("* * * * * matches any date", async () => {
		const result = await page.evaluate(() => {
			return (window as any).cronMatches("* * * * *", new Date(2025, 2, 15, 14, 30));
		});
		expect(result).toBe(true);
	});

	test("0 9 * * * matches 09:00 but not 09:01", async () => {
		const at0900 = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * *", new Date(2025, 2, 15, 9, 0)));
		expect(at0900).toBe(true);

		const at0901 = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * *", new Date(2025, 2, 15, 9, 1)));
		expect(at0901).toBe(false);

		const at1000 = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * *", new Date(2025, 2, 15, 10, 0)));
		expect(at1000).toBe(false);
	});

	test("*/15 * * * * matches :00, :15, :30, :45 but not :07", async () => {
		for (const m of [0, 15, 30, 45]) {
			const result = await page.evaluate(([min]) =>
				(window as any).cronMatches("*/15 * * * *", new Date(2025, 0, 1, 12, min)), [m]);
			expect(result).toBe(true);
		}
		const notMatch = await page.evaluate(() =>
			(window as any).cronMatches("*/15 * * * *", new Date(2025, 0, 1, 12, 7)));
		expect(notMatch).toBe(false);
	});

	test("1-5 * * * * matches minutes 1-5 but not 0 or 6", async () => {
		for (const m of [1, 2, 3, 4, 5]) {
			const result = await page.evaluate(([min]) =>
				(window as any).cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, min)), [m]);
			expect(result).toBe(true);
		}
		const not0 = await page.evaluate(() =>
			(window as any).cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, 0)));
		expect(not0).toBe(false);

		const not6 = await page.evaluate(() =>
			(window as any).cronMatches("1-5 * * * *", new Date(2025, 0, 1, 12, 6)));
		expect(not6).toBe(false);
	});

	test("1,15,30 * * * * matches 1, 15, 30 but not 2", async () => {
		for (const m of [1, 15, 30]) {
			const result = await page.evaluate(([min]) =>
				(window as any).cronMatches("1,15,30 * * * *", new Date(2025, 0, 1, 12, min)), [m]);
			expect(result).toBe(true);
		}
		const not2 = await page.evaluate(() =>
			(window as any).cronMatches("1,15,30 * * * *", new Date(2025, 0, 1, 12, 2)));
		expect(not2).toBe(false);
	});

	test("0 9 * * 1-5 matches weekday 09:00 but not Sunday 09:00", async () => {
		// 2025-03-17 is a Monday (dow=1)
		const monday = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * 1-5", new Date(2025, 2, 17, 9, 0)));
		expect(monday).toBe(true);

		// 2025-03-21 is a Friday (dow=5)
		const friday = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * 1-5", new Date(2025, 2, 21, 9, 0)));
		expect(friday).toBe(true);

		// 2025-03-16 is a Sunday (dow=0)
		const sunday = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * 1-5", new Date(2025, 2, 16, 9, 0)));
		expect(sunday).toBe(false);

		// 2025-03-22 is a Saturday (dow=6)
		const saturday = await page.evaluate(() =>
			(window as any).cronMatches("0 9 * * 1-5", new Date(2025, 2, 22, 9, 0)));
		expect(saturday).toBe(false);
	});

	test("0 0 1 1 * matches midnight Jan 1", async () => {
		const match = await page.evaluate(() =>
			(window as any).cronMatches("0 0 1 1 *", new Date(2025, 0, 1, 0, 0)));
		expect(match).toBe(true);

		const noMatch = await page.evaluate(() =>
			(window as any).cronMatches("0 0 1 1 *", new Date(2025, 0, 2, 0, 0)));
		expect(noMatch).toBe(false);

		const wrongMonth = await page.evaluate(() =>
			(window as any).cronMatches("0 0 1 1 *", new Date(2025, 1, 1, 0, 0)));
		expect(wrongMonth).toBe(false);
	});

	test("59 23 31 12 * matches 23:59 Dec 31", async () => {
		const match = await page.evaluate(() =>
			(window as any).cronMatches("59 23 31 12 *", new Date(2025, 11, 31, 23, 59)));
		expect(match).toBe(true);

		const noMatch = await page.evaluate(() =>
			(window as any).cronMatches("59 23 31 12 *", new Date(2025, 11, 31, 23, 58)));
		expect(noMatch).toBe(false);
	});

	test("day of week 0 and 7 both mean Sunday", async () => {
		// 2025-03-16 is a Sunday (dow=0)
		const dow0 = await page.evaluate(() =>
			(window as any).cronMatches("0 0 * * 0", new Date(2025, 2, 16, 0, 0)));
		expect(dow0).toBe(true);

		const dow7 = await page.evaluate(() =>
			(window as any).cronMatches("0 0 * * 7", new Date(2025, 2, 16, 0, 0)));
		expect(dow7).toBe(true);

		// Monday should not match either
		const monday0 = await page.evaluate(() =>
			(window as any).cronMatches("0 0 * * 0", new Date(2025, 2, 17, 0, 0)));
		expect(monday0).toBe(false);

		const monday7 = await page.evaluate(() =>
			(window as any).cronMatches("0 0 * * 7", new Date(2025, 2, 17, 0, 0)));
		expect(monday7).toBe(false);
	});

	test("invalid cron expression (wrong number of fields) returns false", async () => {
		const result = await page.evaluate(() =>
			(window as any).cronMatches("0 9 *", new Date()));
		expect(result).toBe(false);
	});
});
