import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe("isHtmlContent detection", () => {
	test("correctly identifies HTML vs non-HTML content", async ({ page }) => {
		const fixturePath = path.join(__dirname, "fixtures", "html-artifact-detection.html");
		await page.goto(`file://${fixturePath}`);

		const results = await page.evaluate(() => (window as any).__testResults);
		expect(results.allPassed).toBe(true);

		// Log individual failures for debugging
		for (const r of results.results) {
			if (!r.passed) {
				console.error(`FAIL: "${r.name}" — expected ${r.expected}, got ${r.actual}`);
			}
		}
	});
});
