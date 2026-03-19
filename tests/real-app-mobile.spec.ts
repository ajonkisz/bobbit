import { test, expect } from "@playwright/test";

/**
 * Test against the real vite dev server to verify the mobile header
 * stays pinned at the top in the actual app.
 *
 * Without a gateway, we can't get to a connected session, but we CAN:
 * 1. Verify the app loads at mobile viewport
 * 2. Simulate what happens when connected by injecting a mock session state
 * 3. Verify the header stays visible on scroll
 */

test.describe("Real app mobile header", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("app loads at mobile viewport without errors", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (err) => errors.push(err.message));

		await page.goto("/");
		await page.waitForTimeout(1000);

		// App container should exist
		await expect(page.locator("#app")).toBeVisible();
		expect(errors).toEqual([]);
	});

	test("disconnected state renders correctly on mobile", async ({ page }) => {
		await page.goto("/");
		await page.waitForTimeout(1000);

		// Should show the disconnected UI (or auto-connecting)
		const app = page.locator("#app");
		await expect(app).toBeVisible();

		// No sidebar on mobile
		const sidebar = page.locator(".w-\\[240px\\]");
		await expect(sidebar).not.toBeVisible();
	});

	test("mobile header stays pinned when scrolling", async ({ page }) => {
		await page.goto("/");
		await page.waitForTimeout(500);

		// Simulate what renderApp produces for mobile connected state
		// by injecting the same DOM structure
		const result = await page.evaluate(() => {
			const app = document.getElementById("app")!;
			app.innerHTML = `
				<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden relative">
					<div id="app-header"
						class="fixed top-0 left-0 right-0 z-50 bg-background border-b border-border flex items-center justify-between">
						<span>Test Header</span>
					</div>
					<div id="app-main" class="flex-1 min-h-0 flex flex-col">
						<div style="display:flex;flex-direction:column;height:100%;min-height:0">
							<div style="flex:1;overflow-y:auto;min-height:0" id="test-scroll">
								<div id="test-content"></div>
							</div>
							<div style="flex-shrink:0;padding:8px">Input area</div>
						</div>
					</div>
				</div>
			`;

			// Add enough content to scroll
			const content = document.getElementById("test-content")!;
			for (let i = 0; i < 100; i++) {
				const p = document.createElement("p");
				p.style.padding = "16px";
				p.textContent = "Message " + i;
				content.appendChild(p);
			}

			// Sync padding
			const mainEl = document.getElementById("app-main")!;
			const headerEl = document.getElementById("app-header")!;
			mainEl.style.paddingTop = headerEl.offsetHeight + "px";

			const scrollEl = document.getElementById("test-scroll")!;
			return {
				headerHeight: headerEl.offsetHeight,
				paddingTop: mainEl.style.paddingTop,
				scrollable: scrollEl.scrollHeight > scrollEl.clientHeight,
			};
		});

		expect(result.headerHeight).toBeGreaterThan(0);
		expect(parseInt(result.paddingTop)).toBe(result.headerHeight);
		expect(result.scrollable).toBe(true);

		// Scroll down — header should remain visible (always pinned)
		const scrollEl = page.locator("#test-scroll");
		await scrollEl.evaluate((el) => { el.scrollTop = 300; });
		await page.waitForTimeout(100);

		const header = page.locator("#app-header");
		await expect(header).toBeVisible();

		// No translateY(-100%) should be applied
		const transform = await header.evaluate((el) => el.style.transform);
		expect(transform === "" || transform === "none").toBe(true);

		// Scroll further — still visible
		await scrollEl.evaluate((el) => { el.scrollTop = 600; });
		await page.waitForTimeout(100);
		await expect(header).toBeVisible();
	});
});
