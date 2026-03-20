import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/session-colors.html")}`;

test.describe("Bobbit session colors palette", () => {
	test("palette has exactly 17 colours", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const count = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS.length);
		expect(count).toBe(17);
	});

	test("palette does not contain removed hue values 200, 225, or 250", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		expect(palette).not.toContain(200);
		expect(palette).not.toContain(225);
		expect(palette).not.toContain(250);
	});

	test("palette retains all expected hue values in order", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		const expected = [0, 25, 50, 75, 100, 125, 150, 175, -135, -110, -85, -60, -35, -10, 15, 40, 65];
		expect(palette).toEqual(expected);
	});

	test("nextAvailableColorIndex assigns sequential indices", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const indices = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			const results: number[] = [];
			for (let i = 0; i < 17; i++) {
				w.__sessionHueRotation(`session-${i}`);
				results.push(w.__sessionColorMap.get(`session-${i}`));
			}
			return results;
		});
		expect(indices).toEqual(Array.from({ length: 17 }, (_, i) => i));
	});

	test("wraps around when all 17 colours are used", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const idx = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			for (let i = 0; i < 17; i++) {
				w.__sessionHueRotation(`session-${i}`);
			}
			w.__sessionHueRotation("session-extra");
			return w.__sessionColorMap.get("session-extra");
		});
		expect(idx).toBe(0);
	});

	test("each hue rotation value is unique", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		const unique = new Set(palette);
		expect(unique.size).toBe(palette.length);
	});

	test("same session always gets same colour", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const [first, second] = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			const a = w.__sessionHueRotation("test-session");
			const b = w.__sessionHueRotation("test-session");
			return [a, b];
		});
		expect(first).toBe(second);
	});
});
