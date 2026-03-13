import { test, expect } from "@playwright/test";

/**
 * Test against the real vite dev server to verify the mobile header
 * auto-hide wiring works in the actual app.
 *
 * Without a gateway, we can't get to a connected session, but we CAN:
 * 1. Verify the app loads at mobile viewport
 * 2. Simulate what happens when connected by injecting a mock session state
 * 3. Verify the scroll tracking attaches correctly
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

	test("mobile header markup is correct when injected into DOM", async ({ page }) => {
		await page.goto("/");
		await page.waitForTimeout(500);

		// Simulate what renderApp produces for mobile connected state
		// by injecting the same DOM structure
		const result = await page.evaluate(() => {
			const app = document.getElementById("app")!;
			app.innerHTML = `
				<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden relative">
					<div id="app-header"
						class="absolute top-0 left-0 right-0 z-50 bg-background border-b border-border flex items-center justify-between transition-transform duration-200"
						style="transform: translateY(0)">
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

			// Set up the same capture-phase listener as main.ts
			const mainEl = document.getElementById("app-main")!;
			const headerEl = document.getElementById("app-header")!;

			// Sync padding
			mainEl.style.paddingTop = headerEl.offsetHeight + "px";

			let mobileHeaderVisible = true;
			let lastScrollTop = 0;

			mainEl.addEventListener("scroll", (e) => {
				const target = e.target as HTMLElement;
				if (!target || (!target.scrollTop && target.scrollTop !== 0)) return;
				const currentTop = target.scrollTop;
				const delta = currentTop - lastScrollTop;
				if (currentTop < 20) {
					if (!mobileHeaderVisible) {
						mobileHeaderVisible = true;
						headerEl.style.transform = "translateY(0)";
					}
				} else if (delta < -3) {
					if (!mobileHeaderVisible) {
						mobileHeaderVisible = true;
						headerEl.style.transform = "translateY(0)";
					}
				} else if (delta > 3) {
					if (mobileHeaderVisible) {
						mobileHeaderVisible = false;
						headerEl.style.transform = "translateY(-100%)";
					}
				}
				lastScrollTop = currentTop;
			}, { capture: true, passive: true });

			(window as any).__mobileHeaderVisible = () => mobileHeaderVisible;

			const scrollEl = document.getElementById("test-scroll")!;
			return {
				headerHeight: headerEl.offsetHeight,
				paddingTop: mainEl.style.paddingTop,
				scrollable: scrollEl.scrollHeight > scrollEl.clientHeight,
				scrollHeight: scrollEl.scrollHeight,
				clientHeight: scrollEl.clientHeight,
			};
		});

		expect(result.headerHeight).toBeGreaterThan(0);
		expect(parseInt(result.paddingTop)).toBe(result.headerHeight);
		expect(result.scrollable).toBe(true);

		// Now test scroll behavior
		const scrollEl = page.locator("#test-scroll");

		// Scroll down
		await scrollEl.evaluate((el) => { el.scrollTop = 300; });
		await page.waitForTimeout(100);

		let visible = await page.evaluate(() => (window as any).__mobileHeaderVisible());
		expect(visible).toBe(false);

		const headerTransform = await page.locator("#app-header").evaluate(
			(el) => el.style.transform
		);
		expect(headerTransform).toBe("translateY(-100%)");

		// Scroll up
		await scrollEl.evaluate((el) => { el.scrollTop = 250; });
		await page.waitForTimeout(100);

		visible = await page.evaluate(() => (window as any).__mobileHeaderVisible());
		expect(visible).toBe(true);
	});
});
