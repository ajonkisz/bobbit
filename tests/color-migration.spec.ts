import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/color-migration.html")}`;

test.describe("Color palette migration from v1 (20-colour) to current (17-colour)", () => {
	test("indices 0-7 are unchanged", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 8 }, (_, i) => w.__migrateIndex(i, w.__V1_TO_CURRENT));
		});
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	test("removed index 8 (200°) maps to 7 (175°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__migrateIndex(8, (window as any).__V1_TO_CURRENT));
		expect(r).toBe(7);
	});

	test("removed index 9 (225°) maps to 7 (175°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__migrateIndex(9, (window as any).__V1_TO_CURRENT));
		expect(r).toBe(7);
	});

	test("removed index 19 (250°) maps to 8 (-135°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__migrateIndex(19, (window as any).__V1_TO_CURRENT));
		expect(r).toBe(8);
	});

	test("indices 10-18 shift down by 2", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 9 }, (_, i) => w.__migrateIndex(i + 10, w.__V1_TO_CURRENT));
		});
		expect(results).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
	});

	test("v1 migration preserves hue for shifted indices 10-18", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const allMatch = await page.evaluate(() => {
			const w = window as any;
			for (let oldIdx = 10; oldIdx <= 18; oldIdx++) {
				const newIdx = w.__migrateIndex(oldIdx, w.__V1_TO_CURRENT);
				if (w.__V1_PALETTE[oldIdx] !== w.__NEW_PALETTE[newIdx]) return false;
			}
			return true;
		});
		expect(allMatch).toBe(true);
	});

	test("all v1 migrated indices are within 0-16", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const allValid = await page.evaluate(() => {
			const w = window as any;
			for (let i = 0; i < 20; i++) {
				const newIdx = w.__migrateIndex(i, w.__V1_TO_CURRENT);
				if (newIdx < 0 || newIdx > 16) return false;
			}
			return true;
		});
		expect(allValid).toBe(true);
	});

	test("bulk v1 migration", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const w = window as any;
			return w.__migrateColorMap({
				"a": 0, "b": 8, "c": 9, "d": 12, "e": 19, "f": 18,
			}, w.__V1_TO_CURRENT);
		});
		expect(result).toEqual({ a: 0, b: 7, c: 7, d: 10, e: 8, f: 16 });
	});
});

test.describe("Color palette migration from v2 (18-colour) to current (17-colour)", () => {
	test("indices 0-7 are unchanged", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 8 }, (_, i) => w.__migrateIndex(i, w.__V2_TO_CURRENT));
		});
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	test("removed index 8 (225°) maps to 7 (175°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const r = await page.evaluate(() => (window as any).__migrateIndex(8, (window as any).__V2_TO_CURRENT));
		expect(r).toBe(7);
	});

	test("indices 9-17 shift down by 1", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 9 }, (_, i) => w.__migrateIndex(i + 9, w.__V2_TO_CURRENT));
		});
		expect(results).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
	});

	test("v2 migration preserves hue for shifted indices 9-17", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const allMatch = await page.evaluate(() => {
			const w = window as any;
			for (let oldIdx = 9; oldIdx <= 17; oldIdx++) {
				const newIdx = w.__migrateIndex(oldIdx, w.__V2_TO_CURRENT);
				if (w.__V2_PALETTE[oldIdx] !== w.__NEW_PALETTE[newIdx]) return false;
			}
			return true;
		});
		expect(allMatch).toBe(true);
	});

	test("all v2 migrated indices are within 0-16", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const allValid = await page.evaluate(() => {
			const w = window as any;
			for (let i = 0; i < 18; i++) {
				const newIdx = w.__migrateIndex(i, w.__V2_TO_CURRENT);
				if (newIdx < 0 || newIdx > 16) return false;
			}
			return true;
		});
		expect(allValid).toBe(true);
	});
});
