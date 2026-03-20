import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/color-migration.html")}`;

test.describe("V1 (20-colour) → current (14-colour) migration", () => {
	test("all migrated indices are within 0-13", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const valid = await page.evaluate(() => {
			const w = window as any;
			for (let i = 0; i < 20; i++) {
				const n = w.__migrateIndex(i, w.__V1_TO_CURRENT);
				if (n < 0 || n > 13) return false;
			}
			return true;
		});
		expect(valid).toBe(true);
	});

	test("preserved hues map to correct new index", async ({ page }) => {
		await page.goto(TEST_PAGE);
		// V1 indices that have matching hues in V4: check a few key ones
		const checks = await page.evaluate(() => {
			const w = window as any;
			// V1[0]=0° → V4[5]=0°, V1[3]=75° → V4[11]=75°, V1[10]=-135° → V4[0]=-110° (nearest)
			return [
				w.__V1_PALETTE[0] === w.__NEW_PALETTE[w.__migrateIndex(0, w.__V1_TO_CURRENT)],  // 0° → 0°
				w.__V1_PALETTE[3] === w.__NEW_PALETTE[w.__migrateIndex(3, w.__V1_TO_CURRENT)],  // 75° → 75°
				w.__V1_PALETTE[4] === w.__NEW_PALETTE[w.__migrateIndex(4, w.__V1_TO_CURRENT)],  // 100° → 100°
				w.__V1_PALETTE[11] === w.__NEW_PALETTE[w.__migrateIndex(11, w.__V1_TO_CURRENT)], // -110° → -110°
			];
		});
		expect(checks).toEqual([true, true, true, true]);
	});
});

test.describe("V3 (17-colour) → current (14-colour) migration", () => {
	test("all migrated indices are within 0-13", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const valid = await page.evaluate(() => {
			const w = window as any;
			for (let i = 0; i < 17; i++) {
				const n = w.__migrateIndex(i, w.__V3_TO_CURRENT);
				if (n < 0 || n > 13) return false;
			}
			return true;
		});
		expect(valid).toBe(true);
	});

	test("preserved hues map correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const checks = await page.evaluate(() => {
			const w = window as any;
			// V3[0]=0° → V4[5]=0°, V3[9]=-110° → V4[0]=-110°, V3[16]=65° → V4[10]=65°
			return [
				w.__V3_PALETTE[0] === w.__NEW_PALETTE[w.__migrateIndex(0, w.__V3_TO_CURRENT)],
				w.__V3_PALETTE[9] === w.__NEW_PALETTE[w.__migrateIndex(9, w.__V3_TO_CURRENT)],
				w.__V3_PALETTE[16] === w.__NEW_PALETTE[w.__migrateIndex(16, w.__V3_TO_CURRENT)],
			];
		});
		expect(checks).toEqual([true, true, true]);
	});

	test("removed hues (150°, 175°, -135°) map to nearest", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const results = await page.evaluate(() => {
			const w = window as any;
			return {
				// V3[6]=150° → 13 (125°, nearest)
				idx150: w.__migrateIndex(6, w.__V3_TO_CURRENT),
				// V3[7]=175° → 13 (125°, nearest)
				idx175: w.__migrateIndex(7, w.__V3_TO_CURRENT),
				// V3[8]=-135° → 0 (-110°, nearest)
				idxN135: w.__migrateIndex(8, w.__V3_TO_CURRENT),
			};
		});
		expect(results.idx150).toBe(13);
		expect(results.idx175).toBe(13);
		expect(results.idxN135).toBe(0);
	});
});
