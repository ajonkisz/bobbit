import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("session-colors.ts source verification", () => {
	const sourceFile = path.resolve("src/app/session-colors.ts");
	let values: number[];

	test.beforeAll(() => {
		const source = fs.readFileSync(sourceFile, "utf-8");
		const match = source.match(/BOBBIT_HUE_ROTATIONS\s*=\s*\[([\s\S]*?)\]/);
		values = match![1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
	});

	test("has exactly 14 entries", () => {
		expect(values.length).toBe(14);
	});

	test("does not contain removed values (150, 175, 200, 225, 250, -135)", () => {
		for (const v of [150, 175, 200, 225, 250, -135]) {
			expect(values).not.toContain(v);
		}
	});

	test("contains expected values", () => {
		expect(values).toEqual([-110, -85, -60, -35, -10, 0, 15, 25, 40, 50, 65, 75, 100, 125]);
	});
});
