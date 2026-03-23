import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/verdict-parsing.html")}`;

test.describe("parseVerdict — verdict tag parsing", () => {
	test("all verdict parsing cases pass", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const results = await page.evaluate(() => (window as any).testResults);

		// Enumerate every case so failures are descriptive
		expect(results.basic_pass, "<verdict>pass</verdict> → true").toBe(true);
		expect(results.basic_fail, "<verdict>fail</verdict> → false").toBe(true);
		expect(results.whitespace_pass, "<verdict> pass </verdict> → true").toBe(true);
		expect(results.case_upper_pass, "<verdict>PASS</verdict> → true").toBe(true);
		expect(results.case_upper_fail, "<verdict>FAIL</verdict> → false").toBe(true);
		expect(results.no_tag, "no verdict tag → null").toBe(true);
		expect(results.empty_string, "empty string → null").toBe(true);
		expect(results.invalid_value, "<verdict>maybe</verdict> → null").toBe(true);
		expect(results.multiple_tags, "multiple tags → first wins").toBe(true);
		expect(results.embedded_in_review, "verdict inside <review> wrapper").toBe(true);
		expect(results.mixed_case, "<verdict>Pass</verdict> → true").toBe(true);
		expect(results.surrounded_by_text, "verdict surrounded by text").toBe(true);
	});
});
