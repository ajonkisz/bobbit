import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { readRealE2EToken } from "./e2e-real-setup.js";

/**
 * End-to-end test for image attachments.
 *
 * Sends a distinctive test image (red triangle on white background with green
 * border) to the agent and verifies that the LLM can describe what it sees.
 * This proves the full image pipeline works: UI → WebSocket → RPC bridge →
 * agent subprocess → LLM vision API.
 *
 * Run with:
 *   npx playwright test tests/e2e/image-attachment.spec.ts --config tests/playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readGatewayToken(): string {
	return readRealE2EToken();
}

async function openApp(page: Page, token: string) {
	await page.goto(`/?token=${encodeURIComponent(token)}`);
	await expect(page.getByText("Sessions", { exact: true })).toBeVisible({ timeout: 15_000 });
}

async function createNewSession(page: Page) {
	await page.locator('button[title="New session"]').click();
	await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });
}

async function waitForAgentIdle(page: Page, timeout = 120_000) {
	await page.waitForFunction(
		() => {
			const ta = document.querySelector("message-editor textarea") as HTMLTextAreaElement | null;
			return ta && !ta.disabled;
		},
		{ timeout },
	);
	await page.waitForTimeout(1_000);
}

/**
 * Get the last assistant message's markdown text content.
 * Targets markdown-block elements to avoid picking up UI chrome
 * (thinking blocks, cost badges, tool call renderers, etc.).
 */
async function getLastAssistantMessage(page: Page): Promise<string> {
	await page.waitForSelector("assistant-message markdown-block", { timeout: 30_000 });

	// Get all markdown-block elements inside assistant-message elements
	const markdownBlocks = page.locator("assistant-message markdown-block");
	const count = await markdownBlocks.count();
	if (count === 0) throw new Error("No assistant markdown content found");
	const lastBlock = markdownBlocks.nth(count - 1);
	return (await lastBlock.textContent()) || "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Image attachment", () => {
	test.setTimeout(180_000);

	let token: string;

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test("LLM can describe a distinctive image sent as an attachment", async ({ page }) => {
		await openApp(page, token);
		await createNewSession(page);

		// Read our test image as base64
		const imagePath = path.join(import.meta.dirname, "test-image-red-triangle.png");
		const imageBuffer = fs.readFileSync(imagePath);
		const base64Content = imageBuffer.toString("base64");

		// Attach the image by injecting it into the message-editor's attachment
		// state via the AgentInterface / ChatPanel, then send a prompt asking
		// the LLM to describe what it sees.
		//
		// The UI supports drag-and-drop and file input for attachments. We'll
		// use the file input approach via Playwright's setInputFiles, or
		// alternatively inject the attachment directly via the WebSocket.
		//
		// Strategy: Use the underlying WebSocket directly since we need to
		// verify the full server-side pipeline. We'll send the prompt+image
		// message via the app's RemoteAgent which is wired to the WebSocket.

		// Approach: Use the file input in the message editor
		// The message-editor has a hidden file input for attachments
		const fileInput = page.locator("message-editor input[type='file']");

		// If there's a file input, use it
		const hasFileInput = (await fileInput.count()) > 0;

		if (hasFileInput) {
			await fileInput.setInputFiles(imagePath);
			// Wait for the attachment-tile element to appear (processing is done)
			await page.waitForSelector("message-editor attachment-tile", { timeout: 10_000 });

			// Type the prompt
			const textarea = page.locator("message-editor textarea");
			await textarea.fill("Describe what you see in this image. Be specific about the shapes and colors.");
			await textarea.press("Enter");
		} else {
			// Fallback: inject image via WebSocket directly by calling
			// the RemoteAgent's prompt method with image data
			await page.evaluate(
				({ base64, mimeType }) => {
					// Access the remote agent from the chat panel
					const chatPanel = document.querySelector("chat-panel") as any;
					if (!chatPanel) throw new Error("chat-panel not found");

					const agent = chatPanel.agent;
					if (!agent) throw new Error("Agent not found on chat-panel");

					// Build a user-with-attachments message
					const message = {
						role: "user-with-attachments",
						content: "Describe what you see in this image. Be specific about the shapes and colors.",
						attachments: [
							{
								id: `test_image_${Date.now()}`,
								type: "image",
								fileName: "test-image.png",
								mimeType,
								size: base64.length,
								content: base64,
								preview: base64,
							},
						],
					};

					agent.prompt(message);
				},
				{ base64: base64Content, mimeType: "image/png" },
			);
		}

		// Wait for the agent to process and respond
		await waitForAgentIdle(page);

		// Get the assistant's response
		const response = await getLastAssistantMessage(page);
		console.log(`Assistant response (first 500 chars): ${response.substring(0, 500)}`);

		// The LLM should describe the image content. Our test image has:
		// - A red triangle
		// - A white background
		// - A green border
		// The LLM must mention at least the triangle and one of the colors.
		const lower = response.toLowerCase();

		const mentionsTriangle = lower.includes("triangle");
		const mentionsRed = lower.includes("red");
		const mentionsGreen = lower.includes("green");
		const mentionsWhite = lower.includes("white");

		console.log(`Mentions triangle: ${mentionsTriangle}`);
		console.log(`Mentions red: ${mentionsRed}`);
		console.log(`Mentions green: ${mentionsGreen}`);
		console.log(`Mentions white: ${mentionsWhite}`);

		// The LLM should at minimum identify it as a red triangle
		expect(mentionsTriangle).toBe(true);
		expect(mentionsRed).toBe(true);

		// Nice-to-have: it may also mention the green border or white background
		if (mentionsGreen || mentionsWhite) {
			console.log("Bonus: LLM also identified green border or white background");
		}
	});

	test("LLM differentiates between two distinct images", async ({ page }) => {
		await openApp(page, token);
		await createNewSession(page);

		// First image: red triangle (green border, white bg)
		const trianglePath = path.join(import.meta.dirname, "test-image-red-triangle.png");
		// Second image: yellow circle (blue bg)
		const circlePath = path.join(import.meta.dirname, "test-image-yellow-circle.png");

		const triangleBase64 = fs.readFileSync(trianglePath).toString("base64");
		const circleBase64 = fs.readFileSync(circlePath).toString("base64");

		// Send first image
		const fileInput = page.locator("message-editor input[type='file']");
		const hasFileInput = (await fileInput.count()) > 0;

		if (hasFileInput) {
			await fileInput.setInputFiles(trianglePath);
			await page.waitForSelector("message-editor attachment-tile", { timeout: 10_000 });
			const textarea = page.locator("message-editor textarea");
			await textarea.fill("Image 1: What shape and color do you see? Answer in one sentence.");
			await textarea.press("Enter");
		} else {
			await page.evaluate(
				({ base64, mimeType }) => {
					const chatPanel = document.querySelector("chat-panel") as any;
					const agent = chatPanel.agent;
					agent.prompt({
						role: "user-with-attachments",
						content: "Image 1: What shape and color do you see? Answer in one sentence.",
						attachments: [
							{
								id: `test_${Date.now()}`,
								type: "image",
								fileName: "triangle.png",
								mimeType,
								size: base64.length,
								content: base64,
								preview: base64,
							},
						],
					});
				},
				{ base64: triangleBase64, mimeType: "image/png" },
			);
		}

		await waitForAgentIdle(page);
		const response1 = await getLastAssistantMessage(page);
		console.log(`Response to triangle image: ${response1.substring(0, 300)}`);

		// Count assistant messages before sending second image
		const assistantCountBefore = await page.locator("assistant-message").count();
		console.log(`Assistant message count before second image: ${assistantCountBefore}`);

		// Now send the second image (yellow circle on blue)
		if (hasFileInput) {
			await fileInput.setInputFiles(circlePath);
			await page.waitForSelector("message-editor attachment-tile", { timeout: 10_000 });
			const textarea = page.locator("message-editor textarea");
			await textarea.fill("Image 2: What shape and color do you see now? Answer in one sentence.");
			await textarea.press("Enter");
		} else {
			await page.evaluate(
				({ base64, mimeType }) => {
					const chatPanel = document.querySelector("chat-panel") as any;
					const agent = chatPanel.agent;
					agent.prompt({
						role: "user-with-attachments",
						content: "Image 2: What shape and color do you see now? Answer in one sentence.",
						attachments: [
							{
								id: `test_${Date.now()}`,
								type: "image",
								fileName: "circle.png",
								mimeType,
								size: base64.length,
								content: base64,
								preview: base64,
							},
						],
					});
				},
				{ base64: circleBase64, mimeType: "image/png" },
			);
		}

		// Wait for a new assistant-message element to appear
		await page.waitForFunction(
			(prevCount) => {
				return document.querySelectorAll("assistant-message").length > prevCount;
			},
			assistantCountBefore,
			{ timeout: 120_000 },
		);

		await waitForAgentIdle(page);
		const response2 = await getLastAssistantMessage(page);
		console.log(`Response to circle image: ${response2.substring(0, 300)}`);

		// First response should mention triangle/red
		const r1 = response1.toLowerCase();
		expect(r1.includes("triangle")).toBe(true);

		// Second response should mention circle/yellow
		const r2 = response2.toLowerCase();
		const mentionsCircle = r2.includes("circle") || r2.includes("dot") || r2.includes("round");
		const mentionsYellow = r2.includes("yellow");
		expect(mentionsCircle).toBe(true);
		expect(mentionsYellow).toBe(true);
	});
});
