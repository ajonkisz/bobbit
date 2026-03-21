import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/suggest-goal.html")}`;

test.describe("suggest-goal tag detection and stripping", () => {
	test("tag present → detected and stripped from text", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__testResults.find((r: any) => r.name === "tag-present"));
		expect(result.pass).toBe(true);
	});

	test("tag absent → not detected", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__testResults.find((r: any) => r.name === "tag-absent"));
		expect(result.pass).toBe(true);
	});

	test("whitespace variants detected and stripped", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__testResults.find((r: any) => r.name === "whitespace-variants"));
		expect(result.pass).toBe(true);
	});

	test("multiple tags → single detection, all stripped", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__testResults.find((r: any) => r.name === "multiple-tags"));
		expect(result.pass).toBe(true);
	});

	test("tag-only content → stripped chunk removed", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => (window as any).__testResults.find((r: any) => r.name === "tag-only-content"));
		expect(result.pass).toBe(true);
	});

	test("button click fires suggest-goal CustomEvent that bubbles", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.click("#test-btn");
		const fired = await page.evaluate(() => (window as any).__eventFired);
		const bubbled = await page.evaluate(() => (window as any).__eventBubbled);
		expect(fired).toBe(true);
		expect(bubbled).toBe(true);
	});
});
