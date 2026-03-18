/**
 * Tests for MessageEditor queue rendering, draft persistence, and command
 * history — all in one fixture that replicates the real component's logic.
 *
 * These tests validate the rendering template, callback wiring, state
 * transitions, draft save/restore, and history cycling — the same code
 * paths that run in the real Lit component.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-queue.html").replace(/\\/g, "/")}`;

test.describe("Queue pill rendering", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("renders queue pills in server order", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setQueue([
				{ id: "q1", text: "first", isSteered: false, createdAt: 1000 },
				{ id: "q2", text: "second", isSteered: false, createdAt: 2000 },
			]);
		});

		const texts = await page.locator(".pill-text").allTextContents();
		expect(texts).toEqual(["first", "second"]);
	});

	test("steered pills show Sent, non-steered show Steer+Remove buttons", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setQueue([
				{ id: "q1", text: "normal", isSteered: false, createdAt: 1000 },
				{ id: "q2", text: "steered", isSteered: true, createdAt: 2000 },
			]);
		});

		// Normal pill: has Steer and Remove buttons
		const steerBtns = page.locator(".steer-btn");
		await expect(steerBtns).toHaveCount(1);
		const removeBtns = page.locator(".remove-btn");
		await expect(removeBtns).toHaveCount(1);

		// Steered pill: has Sent indicator, no buttons
		const sentIndicators = page.locator(".sent-indicator");
		await expect(sentIndicators).toHaveCount(1);
		await expect(sentIndicators.first()).toContainText("Sent");
	});

	test("Steer button fires onSteer with full message", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).resetCalls();
			(window as any).setQueue([
				{ id: "q1", text: "steer me", isSteered: false, createdAt: 1000 },
			]);
		});

		await page.locator(".steer-btn").click();
		const calls = await page.evaluate(() => (window as any).getSteerCalls());
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("q1");
		expect(calls[0].text).toBe("steer me");
	});

	test("Remove button fires onRemoveQueued with id", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).resetCalls();
			(window as any).setQueue([
				{ id: "q1", text: "remove me", isSteered: false, createdAt: 1000 },
			]);
		});

		await page.locator(".remove-btn").click();
		const calls = await page.evaluate(() => (window as any).getRemoveCalls());
		expect(calls).toEqual(["q1"]);
	});

	test("queue update re-renders: 2 → 1 → 0 pills", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setQueue([
				{ id: "q1", text: "A", isSteered: false, createdAt: 1000 },
				{ id: "q2", text: "B", isSteered: false, createdAt: 2000 },
			]);
		});
		await expect(page.locator(".queue-pill")).toHaveCount(2);

		await page.evaluate(() => {
			(window as any).setQueue([
				{ id: "q2", text: "B", isSteered: true, createdAt: 2000 },
			]);
		});
		await expect(page.locator(".queue-pill")).toHaveCount(1);
		expect(await page.locator(".queue-pill").getAttribute("data-steered")).toBe("true");

		await page.evaluate(() => (window as any).setQueue([]));
		await expect(page.locator(".queue-pill")).toHaveCount(0);
	});

	test("server ordering preserved (steered first, no client sort)", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setQueue([
				{ id: "q3", text: "steered C", isSteered: true, createdAt: 3000 },
				{ id: "q2", text: "steered B", isSteered: true, createdAt: 2000 },
				{ id: "q1", text: "normal A", isSteered: false, createdAt: 1000 },
			]);
		});

		const texts = await page.locator(".pill-text").allTextContents();
		expect(texts).toEqual(["steered C", "steered B", "normal A"]);
	});
});

test.describe("Draft persistence (integrated)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		// Clear any leftover drafts
		await page.evaluate(() => sessionStorage.clear());
	});

	test("saves draft to sessionStorage after debounce", async ({ page }) => {
		await page.fill("#textarea", "my draft text");
		// Wait for debounce (100ms in fixture)
		await page.waitForTimeout(200);

		const saved = await page.evaluate(() =>
			sessionStorage.getItem("bobbit_draft_default-session"),
		);
		expect(saved).toBe("my draft text");
	});

	test("clearDraft removes from sessionStorage", async ({ page }) => {
		await page.fill("#textarea", "will be cleared");
		await page.waitForTimeout(200);

		await page.evaluate(() => (window as any).clearDraft());
		const saved = await page.evaluate(() =>
			sessionStorage.getItem("bobbit_draft_default-session"),
		);
		expect(saved).toBeNull();
		expect(await page.inputValue("#textarea")).toBe("");
	});

	test("switching session restores correct draft", async ({ page }) => {
		// Set draft for session A
		await page.evaluate(() => (window as any).setSessionId("session-A"));
		await page.fill("#textarea", "draft for A");
		await page.waitForTimeout(200);

		// Switch to session B, type different draft
		await page.evaluate(() => (window as any).setSessionId("session-B"));
		await page.fill("#textarea", "draft for B");
		await page.waitForTimeout(200);

		// Switch back to A — should restore A's draft
		await page.evaluate(() => (window as any).setSessionId("session-A"));
		expect(await page.inputValue("#textarea")).toBe("draft for A");

		// Switch to B — should restore B's draft
		await page.evaluate(() => (window as any).setSessionId("session-B"));
		expect(await page.inputValue("#textarea")).toBe("draft for B");
	});
});

test.describe("Command history (integrated)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => {
			(window as any).setHistory(["first", "second", "third"]);
		});
	});

	test("up arrow cycles newest-first, down returns to draft", async ({ page }) => {
		await page.click("#textarea");

		await page.keyboard.press("ArrowUp");
		expect(await page.inputValue("#textarea")).toBe("third");

		await page.keyboard.press("ArrowUp");
		expect(await page.inputValue("#textarea")).toBe("second");

		await page.keyboard.press("ArrowUp");
		expect(await page.inputValue("#textarea")).toBe("first");

		// At oldest — stays put
		await page.keyboard.press("ArrowUp");
		expect(await page.inputValue("#textarea")).toBe("first");

		// Down cycles back
		await page.keyboard.press("ArrowDown");
		expect(await page.inputValue("#textarea")).toBe("second");

		await page.keyboard.press("ArrowDown");
		expect(await page.inputValue("#textarea")).toBe("third");

		// Past newest — restores empty draft
		await page.keyboard.press("ArrowDown");
		expect(await page.inputValue("#textarea")).toBe("");
	});

	test("draft saved on first up, restored on down back", async ({ page }) => {
		await page.fill("#textarea", "my unsent draft");
		await page.click("#textarea"); // ensure focus

		await page.keyboard.press("ArrowUp");
		expect(await page.inputValue("#textarea")).toBe("third");

		// Go all the way back down
		await page.keyboard.press("ArrowDown");
		expect(await page.inputValue("#textarea")).toBe("my unsent draft");

		const state = await page.evaluate(() => (window as any).getHistoryState());
		expect(state.historyIndex).toBe(-1);
	});
});
