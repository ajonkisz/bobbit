import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/session-colors.html")}`;
const EXPECTED = [-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125];

test.describe("Bobbit session colors palette", () => {
	test("palette has exactly 14 colours", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const count = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS.length);
		expect(count).toBe(14);
	});

	test("palette does not contain removed hue values", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		for (const removed of [150, 175, 200, 225, 250, -135]) {
			expect(palette).not.toContain(removed);
		}
	});

	test("palette matches expected values in order", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		expect(palette).toEqual(EXPECTED);
	});

	test("assigns sequential indices up to 14", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const indices = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			const r: number[] = [];
			for (let i = 0; i < 14; i++) {
				w.__sessionHueRotation(`s-${i}`);
				r.push(w.__sessionColorMap.get(`s-${i}`));
			}
			return r;
		});
		expect(indices).toEqual(Array.from({ length: 14 }, (_, i) => i));
	});

	test("wraps around after all 14 colours used", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const idx = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			for (let i = 0; i < 14; i++) w.__sessionHueRotation(`s-${i}`);
			w.__sessionHueRotation("extra");
			return w.__sessionColorMap.get("extra");
		});
		expect(idx).toBe(0);
	});

	test("each hue value is unique", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const palette = await page.evaluate(() => (window as any).__BOBBIT_HUE_ROTATIONS as number[]);
		expect(new Set(palette).size).toBe(palette.length);
	});

	test("same session always gets same colour", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const [a, b] = await page.evaluate(() => {
			const w = window as any;
			w.__reset();
			return [w.__sessionHueRotation("test"), w.__sessionHueRotation("test")];
		});
		expect(a).toBe(b);
	});
});
