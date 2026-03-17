import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-split-layout.html")}`;

/**
 * Goal assistant split-screen layout tests.
 *
 * Reproduces the real desktop layout: sidebar (240px) + main area containing
 * a 50/50 chat-panel / preview-panel split. Verifies that neither panel
 * overflows the viewport, especially after the spec is populated with
 * realistic content.
 *
 * Run with:
 *   npx playwright test tests/goal-split-layout.spec.ts --config tests/playwright.config.ts
 */

const VIEWPORT = { width: 1536, height: 864 }; // common 1080p-scaled laptop
const SIDEBAR_WIDTH = 240;

test.describe("Goal assistant split-screen layout", () => {
	test.use({ viewport: VIEWPORT });

	test("empty state: both panels stay within the viewport", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("empty"));

		const sidebar = page.locator("#sidebar");
		const chat = page.locator("#chat-panel");
		const preview = page.locator("#preview-panel");
		await expect(sidebar).toBeVisible();
		await expect(chat).toBeVisible();
		await expect(preview).toBeVisible();

		const sidebarBox = await sidebar.boundingBox();
		const chatBox = await chat.boundingBox();
		const previewBox = await preview.boundingBox();

		// Sidebar takes ~240px
		expect(sidebarBox!.width).toBeCloseTo(SIDEBAR_WIDTH, -1);

		// Available width for the split = viewport - sidebar
		const availableWidth = VIEWPORT.width - sidebarBox!.width;

		// Each panel should be roughly half the available width (± 2px for border)
		expect(chatBox!.width).toBeLessThanOrEqual(availableWidth * 0.51);
		expect(previewBox!.width).toBeLessThanOrEqual(availableWidth * 0.51);

		// Nothing extends past the viewport right edge
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(VIEWPORT.width + 1);
	});

	test("populated state: preview panel with full spec stays within viewport", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));

		await expect(page.locator("#preview-spec")).toBeVisible();
		await expect(page.locator("#preview-title")).toHaveValue(/Task Tracking/);

		const sidebarBox = await page.locator("#sidebar").boundingBox();
		const chatBox = await page.locator("#chat-panel").boundingBox();
		const previewBox = await page.locator("#preview-panel").boundingBox();

		const availableWidth = VIEWPORT.width - sidebarBox!.width;
		const halfAvailable = availableWidth / 2;

		// Each panel ≤ 50% of the available space (+ tiny tolerance for border)
		expect(chatBox!.width).toBeLessThanOrEqual(halfAvailable + 2);
		expect(previewBox!.width).toBeLessThanOrEqual(halfAvailable + 2);

		// Preview right edge must not exceed the viewport
		const previewRight = previewBox!.x + previewBox!.width;
		expect(previewRight).toBeLessThanOrEqual(VIEWPORT.width + 1);

		// Both panels together fill the available space (allow a few px for border)
		const totalPanelWidth = chatBox!.width + previewBox!.width;
		expect(totalPanelWidth).toBeGreaterThan(availableWidth - 5);

		await page.screenshot({ path: "test-results/goal-split-populated.png", fullPage: false });
	});

	test("populated state: long chat messages do not push preview off-screen", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));

		// Inject many long messages to stress the chat panel
		await page.evaluate(() => {
			const msgs = document.getElementById("chat-messages")!;
			for (let i = 0; i < 15; i++) {
				const div = document.createElement("div");
				div.className = "message message-assistant";
				div.innerHTML = `<p>${"This is a long assistant response with <code>inline code</code> and detailed technical content that should wrap properly within the chat panel without pushing the preview off-screen. ".repeat(6)}</p>`;
				msgs.appendChild(div);
			}
		});

		await page.waitForTimeout(50);

		const sidebarBox = await page.locator("#sidebar").boundingBox();
		const chatBox = await page.locator("#chat-panel").boundingBox();
		const previewBox = await page.locator("#preview-panel").boundingBox();

		const availableWidth = VIEWPORT.width - sidebarBox!.width;

		// Chat must not exceed 50% of available space
		expect(chatBox!.width).toBeLessThanOrEqual(availableWidth / 2 + 2);

		// Preview stays on-screen
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(VIEWPORT.width + 1);

		await page.screenshot({ path: "test-results/goal-split-long-chat.png", fullPage: false });
	});

	test("populated state: panels are equal width side-by-side", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));
		await expect(page.locator("#preview-spec")).toBeVisible();

		const chatBox = await page.locator("#chat-panel").boundingBox();
		const previewBox = await page.locator("#preview-panel").boundingBox();

		// Panels should be roughly equal width (within 3px for border)
		expect(Math.abs(chatBox!.width - previewBox!.width)).toBeLessThan(3);

		// Preview starts right where chat ends (side-by-side, ±2px for border)
		const gap = previewBox!.x - (chatBox!.x + chatBox!.width);
		expect(gap).toBeGreaterThanOrEqual(-1);
		expect(gap).toBeLessThan(3);
	});

	test("populated state: cwd combobox dropdown stays within viewport", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));

		// Open the dropdown
		await page.locator("#cwd-toggle").click();
		await expect(page.locator("#cwd-dropdown")).toBeVisible();

		const dropdownBox = await page.locator("#cwd-dropdown").boundingBox();
		expect(dropdownBox).toBeTruthy();

		// Dropdown must not extend past the viewport right edge
		expect(dropdownBox!.x + dropdownBox!.width).toBeLessThanOrEqual(VIEWPORT.width + 1);

		// Select an item and verify the input updates
		await page.locator(".cwd-combobox-item").first().click();
		await expect(page.locator("#preview-cwd")).toHaveValue(/bobbit/);

		// Dropdown should close after selection
		await expect(page.locator("#cwd-dropdown")).not.toBeVisible();

		await page.screenshot({ path: "test-results/goal-split-cwd-selected.png", fullPage: false });
	});

	test("populated state: worktree toggle is present and functional", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));

		const toggle = page.locator("#worktree-toggle");
		await expect(toggle).toBeVisible();

		// Should be unchecked by default
		expect(await toggle.isChecked()).toBe(false);

		// Click to enable
		await toggle.click();
		expect(await toggle.isChecked()).toBe(true);
	});

	test("populated state: spec content with wide text wraps instead of overflowing", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).__setPreviewState("populated"));

		// The spec container's visible right edge should be within the viewport
		const specBox = await page.locator("#preview-spec").boundingBox();
		expect(specBox!.x + specBox!.width).toBeLessThanOrEqual(VIEWPORT.width);

		// Verify no horizontal scrollbar on the document
		const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
		expect(hasHScroll).toBe(false);
	});
});
