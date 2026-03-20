import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Tests that verify the source file session-colors.ts has the correct
 * palette after removing colours 9 and 20 (1-indexed).
 */
test.describe("session-colors.ts source verification", () => {
	const sourceFile = path.resolve("src/app/session-colors.ts");
	let source: string;

	test.beforeAll(() => {
		source = fs.readFileSync(sourceFile, "utf-8");
	});

	test("BOBBIT_HUE_ROTATIONS does not contain value 200", () => {
		const match = source.match(/BOBBIT_HUE_ROTATIONS\s*=\s*\[([\s\S]*?)\]/);
		expect(match).toBeTruthy();
		const values = match![1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
		expect(values).not.toContain(200);
	});

	test("BOBBIT_HUE_ROTATIONS does not contain value 250", () => {
		const match = source.match(/BOBBIT_HUE_ROTATIONS\s*=\s*\[([\s\S]*?)\]/);
		expect(match).toBeTruthy();
		const values = match![1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
		expect(values).not.toContain(250);
	});

	test("BOBBIT_HUE_ROTATIONS has exactly 18 entries", () => {
		const match = source.match(/BOBBIT_HUE_ROTATIONS\s*=\s*\[([\s\S]*?)\]/);
		expect(match).toBeTruthy();
		const values = match![1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
		expect(values.length).toBe(18);
	});

	test("BOBBIT_HUE_ROTATIONS contains expected remaining values", () => {
		const match = source.match(/BOBBIT_HUE_ROTATIONS\s*=\s*\[([\s\S]*?)\]/);
		expect(match).toBeTruthy();
		const values = match![1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
		const expected = [0, 25, 50, 75, 100, 125, 150, 175, 225, -135, -110, -85, -60, -35, -10, 15, 40, 65];
		expect(values).toEqual(expected);
	});
});
