import { test, expect } from "@playwright/test";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, "fixtures/remote-agent-message-flow.html");

test("RemoteAgent message flow scenarios", async ({ page }) => {
	await page.goto(`file://${fixturePath}`);
	
	const results = await page.evaluate(() => (window as any).__TEST_RESULTS);
	
	for (const result of results) {
		console.log(`  ${result.passed ? "PASS" : "FAIL"}: ${result.name}`);
	}
	
	// Report individual failures
	const failures = results.filter((r: any) => !r.passed);
	if (failures.length > 0) {
		console.log("\nFailed tests:");
		for (const f of failures) {
			console.log(`  - ${f.name}`);
		}
	}
	
	// Don't fail on expected current-behavior tests (marked as bugs)
	// Just report what we found
	const bugTests = results.filter((r: any) => r.name.includes("LOST"));
	const normalTests = results.filter((r: any) => !r.name.includes("LOST") && !r.name.includes("current behavior"));
	
	console.log(`\n${results.length} scenarios tested`);
	console.log(`${bugTests.length} known bug scenarios confirmed`);
	console.log(`${normalTests.filter((r: any) => r.passed).length}/${normalTests.length} normal scenarios pass`);
	
	// All scenarios should produce expected results (including bug repros)
	expect(results.every((r: any) => r.passed)).toBe(true);
});
