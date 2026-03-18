import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/goal-card-back-nav.html")}#/`;

test.describe("Goal card back navigation", () => {
	test.use({ viewport: { width: 375, height: 667 } }); // mobile

	test("clicking session inside goal card on mobile landing — browser back goes to landing, not goal dashboard", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Verify we start on landing with #/
		await expect(page.locator("#view-landing")).toHaveClass(/active/);

		// Click a session card inside a goal card
		await page.click("#session-card-tl");

		// Wait for async connectToSession to complete
		await page.waitForFunction(() => window.location.hash.includes("session"));

		// Verify we're on the session view
		await expect(page.locator("#view-session")).toHaveClass(/active/);

		// Press browser back
		await page.goBack();

		// Should go to landing, NOT goal dashboard
		await page.waitForFunction(() => !window.location.hash.includes("session"), { timeout: 3000 });
		const hashAfterBack = await page.evaluate(() => window.location.hash);
		const viewLabel = await page.locator("#view-label").textContent();

		// Must NOT be on goal dashboard
		expect(hashAfterBack).not.toContain("/goal/");
		expect(viewLabel).not.toBe("goal-dashboard");
		// Must be on landing
		expect(hashAfterBack).toBe("#/");
		expect(viewLabel).toBe("landing");
	});

	test("clicking session from goal dashboard — browser back goes to landing", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#view-landing")).toHaveClass(/active/);

		// Navigate to goal dashboard by clicking goal card header
		await page.click("#goal-card-2");

		await page.waitForFunction(() => window.location.hash.includes("goal"));
		await expect(page.locator("#view-goal-dashboard")).toHaveClass(/active/);

		// Now click a session from the dashboard
		await page.click("#dashboard-session-tl");

		await page.waitForFunction(() => window.location.hash.includes("session"));
		await expect(page.locator("#view-session")).toHaveClass(/active/);

		// Press browser back — should go to landing (replace removed goal-dashboard entry)
		await page.goBack();

		await page.waitForFunction(() => !window.location.hash.includes("session"), { timeout: 3000 });
		const hashAfterBack = await page.evaluate(() => window.location.hash);
		const viewLabel = await page.locator("#view-label").textContent();

		expect(hashAfterBack).not.toContain("/goal/");
		expect(viewLabel).not.toBe("goal-dashboard");
		expect(hashAfterBack).toBe("#/");
		expect(viewLabel).toBe("landing");
	});

	test("robust: back works even if stopPropagation is bypassed and goal card click fires", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await expect(page.locator("#view-landing")).toHaveClass(/active/);

		// Remove the stopPropagation wrapper to simulate it being bypassed
		await page.evaluate(() => {
			const wrapper = document.getElementById("sessions-wrapper-1")!;
			const clone = wrapper.cloneNode(true) as HTMLElement;
			clone.querySelectorAll(".session-card").forEach(card => {
				card.addEventListener("click", () => {
					(window as any).__connectToSession(card.getAttribute("data-session-id"));
				});
			});
			wrapper.replaceWith(clone);
		});

		// Click the session card — without stopPropagation, the goal card click also fires
		await page.click("#session-card-tl");

		// Wait for session view
		await page.waitForFunction(() => window.location.hash.includes("session"), { timeout: 5000 });

		// Press browser back
		await page.goBack();

		// Should still go to landing, not goal dashboard
		await page.waitForFunction(() => !window.location.hash.includes("session"), { timeout: 3000 });
		const hashAfterBack = await page.evaluate(() => window.location.hash);
		const viewLabel = await page.locator("#view-label").textContent();

		expect(hashAfterBack).not.toContain("/goal/");
		expect(viewLabel).not.toBe("goal-dashboard");
	});
});
