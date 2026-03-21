import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { E2E_PI_DIR, readE2EToken } from "./e2e-setup.js";

/**
 * E2E test: spawn sleeping delegates, open a second tab mid-execution,
 * verify the second tab sees the streaming panel with delegate progress.
 *
 * Run with:
 *   npx playwright test tests/delegate-reconnect.spec.ts --config tests/playwright-workflow.config.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function readGatewayToken(): string {
	// Prefer E2E isolated token; fall back to real ~/.pi for manual runs
	try {
		return readE2EToken();
	} catch {
		return fs.readFileSync(path.join(os.homedir(), ".pi", "gateway-token"), "utf-8").trim();
	}
}

const FRONTEND = process.env.FRONTEND_URL || "http://127.0.0.1:5174";
const API = process.env.GATEWAY_URL || "http://127.0.0.1:3099";

async function createSession(token: string): Promise<string> {
	const resp = await fetch(`${API}/api/sessions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ cwd: process.cwd() }),
	});
	return (await resp.json()).id;
}

async function deleteSession(token: string, id: string): Promise<void> {
	try {
		await fetch(`${API}/api/sessions/${id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}` },
		});
	} catch { /* ignore */ }
}

/** Navigate to a session and wait for the chat UI */
async function openSession(page: Page, token: string, sessionId: string): Promise<void> {
	await page.goto(`${FRONTEND}/?token=${encodeURIComponent(token)}`, { waitUntil: "networkidle" });
	await page.waitForTimeout(2000);
	await page.evaluate((id) => { window.location.hash = `/session/${id}`; }, sessionId);
	// Wait for message-editor inside shadow DOM
	await page.waitForFunction(
		() => !!document.querySelector("message-editor"),
		{ timeout: 20_000 },
	);
	await page.waitForTimeout(1000);
}

/** Type into the message editor and send */
async function sendMessage(page: Page, text: string): Promise<void> {
	// message-editor is a custom element with a textarea in its shadow DOM
	await page.evaluate((msg) => {
		const editor = document.querySelector("message-editor") as any;
		if (!editor) throw new Error("No message-editor found");
		// Use the Lit element's value property + dispatch submit
		const textarea = editor.shadowRoot?.querySelector("textarea") ||
			editor.renderRoot?.querySelector("textarea");
		if (textarea) {
			textarea.value = msg;
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		}
		// Also try setting the value property directly
		if (typeof editor.value === "string") {
			editor.value = msg;
		}
	}, text);
	await page.waitForTimeout(200);
	// Press Enter on the textarea
	await page.evaluate(() => {
		const editor = document.querySelector("message-editor") as any;
		const textarea = editor?.shadowRoot?.querySelector("textarea") ||
			editor?.renderRoot?.querySelector("textarea");
		if (textarea) {
			textarea.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true
			}));
		}
	});
}

/** Check if the streaming container has visible content */
async function getStreamingContainerState(page: Page): Promise<{
	hasStreamingContainer: boolean;
	streamingContainerHasContent: boolean;
	hasDelegateCards: boolean;
	hasLogLinks: boolean;
	hasRunningIndicator: boolean;
	fullHtml: string;
}> {
	return page.evaluate(() => {
		const sc = document.querySelector("streaming-message-container") as any;
		const scRoot = sc?.shadowRoot || sc?.renderRoot;
		const scHtml = scRoot?.innerHTML || "";

		// Also check the whole page
		const fullHtml = document.body.innerHTML;
		// Check shadow DOMs of all custom elements for delegate content
		let allShadowHtml = fullHtml;
		document.querySelectorAll("*").forEach((el: any) => {
			if (el.shadowRoot) {
				allShadowHtml += el.shadowRoot.innerHTML || "";
			}
			if (el.renderRoot && el.renderRoot !== el) {
				allShadowHtml += el.renderRoot.innerHTML || "";
			}
		});

		return {
			hasStreamingContainer: !!sc,
			streamingContainerHasContent: scHtml.length > 50,
			hasDelegateCards: allShadowHtml.includes("delegate-logs/") || allShadowHtml.includes("Delegat"),
			hasLogLinks: allShadowHtml.includes("delegate-logs/"),
			hasRunningIndicator: allShadowHtml.includes("running") || allShadowHtml.includes("⏳") || allShadowHtml.includes("animate-pulse"),
			fullHtml: allShadowHtml.slice(0, 2000),
		};
	});
}

/** Check RemoteAgent state directly */
async function getAgentState(page: Page): Promise<{
	isStreaming: boolean;
	hasStreamMessage: boolean;
	hasToolPartialResults: boolean;
	messageCount: number;
	streamMessageRole: string | null;
}> {
	return page.evaluate(() => {
		const ai = document.querySelector("agent-interface") as any;
		const session = ai?.session;
		const state = session?.state;
		return {
			isStreaming: !!state?.isStreaming,
			hasStreamMessage: !!state?.streamMessage,
			hasToolPartialResults: !!state?.toolPartialResults && Object.keys(state.toolPartialResults).length > 0,
			messageCount: Array.isArray(state?.messages) ? state.messages.length : 0,
			streamMessageRole: state?.streamMessage?.role || null,
		};
	});
}

test.describe("Delegate reconnection state replay", () => {
	let token: string;
	let sessionId: string;

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(token, sessionId);
	});

	test("second tab sees streaming panel with delegate progress", async ({ browser }) => {
		test.setTimeout(120_000);
		sessionId = await createSession(token);

		// ── Tab 1: open session and start delegates ──
		const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
		const page1 = await ctx1.newPage();
		await openSession(page1, token, sessionId);
		await sendMessage(page1, "Use the delegate tool with the parallel parameter to delegate 3 sub-agents: first runs 'sleep 20', second runs 'sleep 30', third runs 'sleep 40'. Just use the tool directly.");

		// Wait for the agent to be streaming and delegate tool to appear
		await page1.waitForFunction(
			() => {
				const ai = document.querySelector("agent-interface") as any;
				return ai?.session?.state?.isStreaming;
			},
			{ timeout: 30_000 },
		);
		console.log("Tab 1: agent is streaming");

		// Wait for delegate tool call to actually appear (heartbeat fires)
		await page1.waitForFunction(
			() => {
				const ai = document.querySelector("agent-interface") as any;
				const state = ai?.session?.state;
				return state?.toolPartialResults && Object.keys(state.toolPartialResults).length > 0;
			},
			{ timeout: 30_000 },
		);
		console.log("Tab 1: has toolPartialResults");

		// Extra wait for heartbeat to populate event buffer
		await page1.waitForTimeout(4_000);

		const tab1State = await getAgentState(page1);
		console.log("Tab 1 state:", JSON.stringify(tab1State));

		// ── Tab 2: open the same session ──
		const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
		const page2 = await ctx2.newPage();
		await openSession(page2, token, sessionId);

		// Give time for messages + event replay to arrive
		await page2.waitForTimeout(3_000);

		// ── Diagnose: check RemoteAgent state ──
		const tab2State = await getAgentState(page2);
		console.log("Tab 2 agent state:", JSON.stringify(tab2State));

		// ── Diagnose: check streaming container ──
		const scState = await getStreamingContainerState(page2);
		console.log("Tab 2 streaming container:", JSON.stringify({
			hasStreamingContainer: scState.hasStreamingContainer,
			streamingContainerHasContent: scState.streamingContainerHasContent,
			hasDelegateCards: scState.hasDelegateCards,
			hasLogLinks: scState.hasLogLinks,
			hasRunningIndicator: scState.hasRunningIndicator,
		}));
		if (!scState.hasDelegateCards) {
			console.log("Tab 2 HTML snippet:", scState.fullHtml.slice(0, 1000));
		}

		// ── Assertions ──
		// Tab 2 must be streaming
		expect(tab2State.isStreaming).toBe(true);
		// Tab 2 must have toolPartialResults from replay
		expect(tab2State.hasToolPartialResults).toBe(true);
		// Tab 2 must show delegate cards in the UI
		expect(scState.hasDelegateCards).toBe(true);

		await ctx1.close();
		await ctx2.close();
	});

	test("page refresh preserves delegate progress", async ({ browser }) => {
		test.setTimeout(120_000);
		const refreshSessionId = await createSession(token);

		const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await ctx.newPage();
		await openSession(page, token, refreshSessionId);
		await sendMessage(page, "Use the delegate tool with the parallel parameter to delegate 3 sub-agents: first runs 'sleep 20', second runs 'sleep 30', third runs 'sleep 40'. Just use the tool directly.");

		// Wait for streaming + toolPartialResults
		await page.waitForFunction(
			() => {
				const ai = document.querySelector("agent-interface") as any;
				const state = ai?.session?.state;
				return state?.isStreaming && state?.toolPartialResults && Object.keys(state.toolPartialResults).length > 0;
			},
			{ timeout: 30_000 },
		);
		console.log("Before refresh: streaming with partialResults");

		// Wait a bit for heartbeat
		await page.waitForTimeout(4_000);

		// REFRESH the page
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(2000);
		// Navigate back to the session
		await page.evaluate((id) => { window.location.hash = `/session/${id}`; }, refreshSessionId);
		await page.waitForFunction(
			() => !!document.querySelector("message-editor"),
			{ timeout: 20_000 },
		);
		await page.waitForTimeout(3_000);

		// Check state after refresh
		const stateAfter = await getAgentState(page);
		console.log("After refresh state:", JSON.stringify(stateAfter));

		// After refresh, streamMessage is null (we don't reconstruct it).
		// Instead, the message-list shows the assistant message with its
		// pending tool calls because hasStreamMessage is false.
		expect(stateAfter.isStreaming).toBe(true);

		// Check that delegate tool card is visible somewhere in the page
		const scState = await getStreamingContainerState(page);
		console.log("After refresh page state:", JSON.stringify({
			hasDelegateCards: scState.hasDelegateCards,
		}));

		expect(scState.hasDelegateCards).toBe(true);

		await deleteSession(token, refreshSessionId);
		await ctx.close();
	});
});
