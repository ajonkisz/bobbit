import { test, expect } from "@playwright/test";

/**
 * Tests for message queuing, steer behavior, and textarea clearing.
 *
 * Uses a Vite-served test fixture that loads the real MessageEditor component.
 * Run with: npx playwright test tests/message-queue.spec.ts
 *
 * Requires `npm run dev` or the vite dev server running on port 5173.
 */

const BASE = "http://localhost:5173";
const TEST_PAGE = `${BASE}/tests/message-queue.html`;

async function waitReady(page: any) {
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 5000 });
}

async function typeInTextarea(page: any, text: string) {
	await page.evaluate((t: string) => (window as any).__typeInTextarea(t), text);
}

async function pressEnter(page: any) {
	await page.evaluate(() => (window as any).__pressEnter());
}

async function setStreaming(page: any, streaming: boolean) {
	await page.evaluate((s: boolean) => (window as any).__setStreaming(s), streaming);
}

async function setQueuedMessages(page: any, messages: any[]) {
	await page.evaluate((m: any[]) => (window as any).__setQueuedMessages(m), messages);
}

async function clearEditor(page: any) {
	await page.evaluate(() => (window as any).__clearEditorValue());
}

async function getTextareaValue(page: any): Promise<string> {
	return page.evaluate(() => (window as any).__getTextareaValue());
}

async function getEditorValue(page: any): Promise<string> {
	return page.evaluate(() => (window as any).__getEditorValue());
}

async function getQueuedTexts(page: any): Promise<string[]> {
	return page.evaluate(() => (window as any).__getQueuedMessageElements());
}

async function getSendCount(page: any): Promise<number> {
	return page.evaluate(() => (window as any).__sends.length);
}

test.describe("Message queue and steer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await waitReady(page);
	});

	// ── Basic send ──

	test("typing and pressing Enter calls onSend with the text", async ({ page }) => {
		await typeInTextarea(page, "hello world");
		await pressEnter(page);

		const count = await getSendCount(page);
		expect(count).toBe(1);

		const sent = await page.evaluate(() => (window as any).__sends[0]);
		expect(sent.text).toBe("hello world");
	});

	test("pressing Enter on empty textarea does not call onSend", async ({ page }) => {
		await pressEnter(page);

		const count = await getSendCount(page);
		expect(count).toBe(0);
	});

	// ── Textarea clearing ──

	test("clearing editor value clears the textarea DOM", async ({ page }) => {
		await typeInTextarea(page, "some text");
		expect(await getTextareaValue(page)).toBe("some text");

		await clearEditor(page);

		expect(await getTextareaValue(page)).toBe("");
		expect(await getEditorValue(page)).toBe("");
	});

	test("textarea stays empty after clear + re-render from queuedMessages change", async ({ page }) => {
		// Simulate: user types, sends (which clears), message goes to queue, queue triggers re-render
		await typeInTextarea(page, "queued msg");
		expect(await getEditorValue(page)).toBe("queued msg");

		// Parent clears editor (as AgentInterface.sendMessage does)
		await clearEditor(page);
		expect(await getTextareaValue(page)).toBe("");

		// Now parent sets queuedMessages (triggers re-render of MessageEditor)
		await setQueuedMessages(page, [
			{ id: "q_1", text: "queued msg" },
		]);

		// Textarea must still be empty — the queued message text must NOT leak into it
		expect(await getTextareaValue(page)).toBe("");
		expect(await getEditorValue(page)).toBe("");
	});

	test("textarea stays empty through multiple queue updates", async ({ page }) => {
		await clearEditor(page);

		// Simulate multiple queue additions (each triggers a re-render)
		for (let i = 1; i <= 3; i++) {
			const msgs = Array.from({ length: i }, (_, j) => ({
				id: `q_${j + 1}`,
				text: `message ${j + 1}`,
			}));
			await setQueuedMessages(page, msgs);
			expect(await getTextareaValue(page)).toBe("");
		}
	});

	test("textarea stays empty when a queued message is steered", async ({ page }) => {
		await clearEditor(page);

		// Set up queue with one message
		await setQueuedMessages(page, [
			{ id: "q_1", text: "steer me" },
		]);
		expect(await getTextareaValue(page)).toBe("");

		// Mark as steered (triggers re-render)
		await setQueuedMessages(page, [
			{ id: "q_1", text: "steer me", steered: true },
		]);
		expect(await getTextareaValue(page)).toBe("");
	});

	test("textarea stays empty when steered message is removed from queue", async ({ page }) => {
		await clearEditor(page);

		await setQueuedMessages(page, [
			{ id: "q_1", text: "msg 1", steered: true },
			{ id: "q_2", text: "msg 2" },
		]);
		expect(await getTextareaValue(page)).toBe("");

		// Remove steered message (simulates agent_end cleanup)
		await setQueuedMessages(page, [
			{ id: "q_2", text: "msg 2" },
		]);
		expect(await getTextareaValue(page)).toBe("");
	});

	// ── Queued message rendering ──

	test("queued messages render above textarea", async ({ page }) => {
		await setQueuedMessages(page, [
			{ id: "q_1", text: "first" },
			{ id: "q_2", text: "second" },
		]);

		const texts = await getQueuedTexts(page);
		expect(texts).toContain("first");
		expect(texts).toContain("second");
	});

	test("steered message shows Sent indicator", async ({ page }) => {
		await setQueuedMessages(page, [
			{ id: "q_1", text: "steered msg", steered: true },
		]);

		// Look for "Sent" text in the steered message row
		const sentText = await page.evaluate(() => {
			const el = document.querySelector("message-editor");
			return el?.innerHTML?.includes("Sent") ?? false;
		});
		expect(sentText).toBe(true);
	});

	test("non-steered message shows Steer button", async ({ page }) => {
		await setQueuedMessages(page, [
			{ id: "q_1", text: "pending msg" },
		]);

		const hasSteerButton = await page.evaluate(() => {
			const el = document.querySelector("message-editor");
			return el?.innerHTML?.includes("Steer") ?? false;
		});
		expect(hasSteerButton).toBe(true);
	});

	// ── Full send-while-streaming flow ──

	test("full queue flow: type, send while streaming, verify textarea empty", async ({ page }) => {
		// Agent is streaming
		await setStreaming(page, true);

		// User types and sends
		await typeInTextarea(page, "interrupt this");

		// Simulate what AgentInterface.sendMessage does:
		// 1. onSend fires (captured by handleSend → onSend callback)
		await pressEnter(page);
		const sendCount = await getSendCount(page);
		expect(sendCount).toBe(1);

		// 2. Parent clears the editor
		await clearEditor(page);

		// 3. Parent adds to queue
		await setQueuedMessages(page, [
			{ id: "q_1", text: "interrupt this" },
		]);

		// Textarea must be empty
		expect(await getTextareaValue(page)).toBe("");
		expect(await getEditorValue(page)).toBe("");

		// Queue should show the message
		const texts = await getQueuedTexts(page);
		expect(texts).toContain("interrupt this");
	});

	test("rapid queue + clear cycles don't leak text into textarea", async ({ page }) => {
		for (let i = 0; i < 5; i++) {
			await typeInTextarea(page, `msg ${i}`);
			await clearEditor(page);
			await setQueuedMessages(page, 
				Array.from({ length: i + 1 }, (_, j) => ({
					id: `q_${j}`,
					text: `msg ${j}`,
				}))
			);
			expect(await getTextareaValue(page)).toBe("");
		}
	});

	// ── isStreaming transitions ──

	test("textarea stays empty when isStreaming toggles with queue present", async ({ page }) => {
		await clearEditor(page);
		await setQueuedMessages(page, [
			{ id: "q_1", text: "queued" },
		]);

		// Toggle streaming on
		await setStreaming(page, true);
		expect(await getTextareaValue(page)).toBe("");

		// Toggle streaming off (agent_end)
		await setStreaming(page, false);
		expect(await getTextareaValue(page)).toBe("");

		// Clear queue (drainQueue equivalent)
		await setQueuedMessages(page, []);
		expect(await getTextareaValue(page)).toBe("");
	});
});
