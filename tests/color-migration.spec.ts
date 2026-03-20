import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/color-migration.html")}`;

test.describe("Color palette migration (20 → 18 colours)", () => {
	test("indices 0-7 are unchanged", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 8 }, (_, i) => w.__migrateIndex(i));
		});
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	test("removed index 8 (hue 200°) maps to index 7 (hue 175°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__migrateIndex(8));
		expect(result).toBe(7);
	});

	test("removed index 19 (hue 250°) maps to index 8 (hue 225°)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__migrateIndex(19));
		expect(result).toBe(8);
	});

	test("indices 9-18 shift down by 1", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return Array.from({ length: 10 }, (_, i) => w.__migrateIndex(i + 9));
		});
		expect(results).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
	});

	test("migration preserves hue continuity for shifted indices", async ({ page }) => {
		await page.goto(TEST_PAGE);
		// For each old index 9-18, the old hue should equal the new hue at the migrated index
		const allMatch = await page.evaluate(() => {
			const w = window as any;
			for (let oldIdx = 9; oldIdx <= 18; oldIdx++) {
				const newIdx = w.__migrateIndex(oldIdx);
				if (w.__OLD_PALETTE[oldIdx] !== w.__NEW_PALETTE[newIdx]) return false;
			}
			return true;
		});
		expect(allMatch).toBe(true);
	});

	test("removed index 8 maps to closest available hue", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const [oldHue, newHue] = await page.evaluate(() => {
			const w = window as any;
			const newIdx = w.__migrateIndex(8);
			return [w.__OLD_PALETTE[8], w.__NEW_PALETTE[newIdx]];
		});
		// Old hue 200°, mapped to 175° (index 7) — 25° difference
		expect(oldHue).toBe(200);
		expect(newHue).toBe(175);
		expect(Math.abs(oldHue - newHue)).toBe(25);
	});

	test("removed index 19 maps to closest available hue", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const [oldHue, newHue] = await page.evaluate(() => {
			const w = window as any;
			const newIdx = w.__migrateIndex(19);
			return [w.__OLD_PALETTE[19], w.__NEW_PALETTE[newIdx]];
		});
		// Old hue 250°, mapped to 225° (index 8) — 25° difference
		expect(oldHue).toBe(250);
		expect(newHue).toBe(225);
		expect(Math.abs(oldHue - newHue)).toBe(25);
	});

	test("all migrated indices are within new palette range (0-17)", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const allValid = await page.evaluate(() => {
			const w = window as any;
			for (let i = 0; i < 20; i++) {
				const newIdx = w.__migrateIndex(i);
				if (newIdx < 0 || newIdx > 17) return false;
			}
			return true;
		});
		expect(allValid).toBe(true);
	});

	test("bulk migration remaps a realistic color map", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const w = window as any;
			return w.__migrateColorMap({
				"session-a": 0,   // stays 0
				"session-b": 8,   // removed → 7
				"session-c": 12,  // shifts → 11
				"session-d": 19,  // removed → 8
				"session-e": 18,  // shifts → 17
			});
		});
		expect(result).toEqual({
			"session-a": 0,
			"session-b": 7,
			"session-c": 11,
			"session-d": 8,
			"session-e": 17,
		});
	});
});
