import { test, expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for the compaction workflow.
 *
 * Run with:
 *   npx playwright test tests/compaction.spec.ts --config tests/playwright-e2e.config.ts
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readGatewayToken(): string {
	const tokenPath = path.join(os.homedir(), ".pi", "gateway-token");
	const token = fs.readFileSync(tokenPath, "utf-8").trim();
	if (!token || token.length < 64) throw new Error("No valid gateway token found");
	return token;
}

function cleanupSessions(token: string) {
	const gw = "http://localhost:3001";
	try {
		const raw = execSync(
			`curl -s -H "Authorization: Bearer ${token}" ${gw}/api/sessions`,
			{ timeout: 5_000 },
		).toString();
		const data = JSON.parse(raw);
		const sessions = Array.isArray(data) ? data : data.sessions ?? [];
		for (const s of sessions) {
			execSync(
				`curl -s -X DELETE -H "Authorization: Bearer ${token}" ${gw}/api/sessions/${s.id}`,
				{ timeout: 5_000 },
			);
		}
		if (sessions.length) console.log(`Cleaned up ${sessions.length} leftover sessions`);
	} catch {
		// Gateway might not be up yet
	}
}

async function openApp(page: Page, token: string) {
	await page.goto(`/?token=${encodeURIComponent(token)}`);
	await expect(page.locator('button[title="New session"]')).toBeVisible({ timeout: 15_000 });
}

async function createNewSession(page: Page) {
	await page.locator('button[title="New session"]').click();
	await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });
}

async function sendMessage(page: Page, text: string) {
	const textarea = page.locator("message-editor textarea");
	await textarea.fill(text);
	await textarea.press("Enter");
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

async function getBlobState(page: Page): Promise<string> {
	return page.evaluate(() => {
		const container = document.querySelector("streaming-message-container") as any;
		return container?._blobState ?? "unknown";
	});
}

async function isRemoteAgentCompacting(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const iface = document.querySelector("agent-interface") as any;
		return iface?.session?._isCompacting ?? false;
	});
}

async function getContextPercentage(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const spans = document.querySelectorAll("agent-interface span[title^='Context:']");
		if (spans.length === 0) return null;
		const span = spans[spans.length - 1];
		const pctSpan = span.querySelector("span:last-child");
		return pctSpan?.textContent?.trim() ?? null;
	});
}

/** Poll until blob reaches target state. */
async function waitForBlobState(page: Page, target: string, timeoutMs = 30_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const state = await getBlobState(page);
		if (state === target) return;
		await page.waitForTimeout(250);
	}
	const final = await getBlobState(page);
	throw new Error(`Blob did not reach "${target}" within ${timeoutMs}ms (stuck at "${final}")`);
}

/** Poll until "Context compacted." appears in RemoteAgent messages or DOM. */
async function waitForCompactionDone(page: Page, timeoutMs = 120_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const found = await page.evaluate(() => {
			const ml = document.querySelector("message-list");
			if (ml?.textContent?.includes("Context compacted.")) return true;
			const iface = document.querySelector("agent-interface") as any;
			const msgs = iface?.session?.state?.messages;
			if (Array.isArray(msgs)) {
				for (const m of msgs) {
					if (m.role === "assistant" && Array.isArray(m.content)) {
						for (const c of m.content) {
							if (c.type === "text" && c.text?.includes("Context compacted.")) return true;
						}
					}
				}
			}
			return false;
		});
		if (found) return;
		await page.waitForTimeout(500);
	}
	throw new Error(`"Context compacted." did not appear within ${timeoutMs}ms`);
}

/** Poll until _isCompacting becomes false. */
async function waitForCompactionEnd(page: Page, timeoutMs = 120_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const still = await isRemoteAgentCompacting(page);
		if (!still) return;
		await page.waitForTimeout(500);
	}
	throw new Error(`_isCompacting still true after ${timeoutMs}ms`);
}

/** Send a message and wait for the full round-trip (streaming → idle). */
async function sendAndWaitForResponse(page: Page, text: string) {
	await sendMessage(page, text);
	// Wait for streaming to start
	const start = Date.now();
	while (Date.now() - start < 60_000) {
		const state = await getBlobState(page);
		const isStreaming = await page.evaluate(() => {
			const iface = document.querySelector("agent-interface") as any;
			return iface?.session?.state?.isStreaming ?? false;
		});
		if (state !== "hidden" || isStreaming) break;
		await page.waitForTimeout(250);
	}
	await waitForAgentIdle(page);
	await waitForBlobState(page, "idle");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Compaction workflow", () => {
	test.setTimeout(180_000);

	let token: string;

	test.beforeAll(async () => {
		token = readGatewayToken();
		cleanupSessions(token);
	});

	test("full compaction lifecycle: animation, sidebar, completion", async ({ page }) => {
		cleanupSessions(token);
		await openApp(page, token);
		await createNewSession(page);

		// Send a message to establish some context
		await sendAndWaitForResponse(page, "Say exactly: 'Hello world'. Nothing else.");

		// Capture context % before compaction
		const contextBefore = await getContextPercentage(page);
		console.log(`Context % before compaction: ${contextBefore}`);

		expect(await getBlobState(page)).toBe("idle");

		// ----- 1. Trigger compaction -----
		await sendMessage(page, "/compact");

		// ----- 2. Verify compaction animation starts -----
		await waitForBlobState(page, "compact-shake", 10_000).catch(() => {});
		const blobDuringCompact = await getBlobState(page);
		console.log(`Blob state during compaction: ${blobDuringCompact}`);
		expect(["entering", "compact-shake", "compacting"]).toContain(blobDuringCompact);

		// Wait for the squashed "compacting" state
		await waitForBlobState(page, "compacting", 10_000);
		console.log("Blob reached 'compacting' (squashed) state");

		// Verify CSS class
		expect(await page.evaluate(() => !!document.querySelector(".bobbit-blob--compacting"))).toBe(true);

		// ----- 3. Verify "Compacting context…" placeholder -----
		const hasPlaceholder = await page.evaluate(() => {
			const ml = document.querySelector("message-list");
			return ml?.textContent?.includes("Compacting context") ?? false;
		});
		expect(hasPlaceholder).toBe(true);
		console.log("Compacting placeholder visible");

		// ----- 4. Verify RemoteAgent tracks compacting state -----
		expect(await isRemoteAgentCompacting(page)).toBe(true);

		// ----- 5. Verify sidebar bobbit is squashed -----
		// Sidebar polls every 5s — wait for it to pick up isCompacting
		{
			const start = Date.now();
			let squashed = false;
			while (Date.now() - start < 10_000) {
				squashed = await page.evaluate(() => {
					const row = document.querySelector(".bg-secondary, .sidebar-session-active");
					if (!row) return false;
					const sprites = row.querySelectorAll("span[style*='box-shadow']");
					for (const s of sprites) {
						if ((s.getAttribute("style") || "").includes("scaleY(0.7)")) return true;
					}
					return false;
				});
				if (squashed) break;
				await page.waitForTimeout(500);
			}
			expect(squashed).toBe(true);
			console.log("Sidebar bobbit is squashed");
		}

		// ----- 6. Verify steer is not available -----
		expect(await page.locator("message-editor button", { hasText: "Steer" }).count()).toBe(0);
		console.log("Steer not available (isStreaming=false during compaction)");

		// ----- 7. Wait for compaction to finish (stay on the session) -----
		// Wait for _isCompacting to become false (compaction_end event received).
		// The "Context compacted." message is added client-side but may be
		// overwritten by the server's post-compaction message refresh — so we
		// rely on the _isCompacting flag as the definitive completion signal.
		await waitForCompactionEnd(page, 120_000);
		console.log("Compaction finished (_isCompacting cleared)");

		// ----- 8. Verify bobbit returns to idle -----
		await waitForBlobState(page, "idle", 15_000);
		console.log("Blob returned to idle");

		// ----- 9. Verify isCompacting cleared -----
		expect(await isRemoteAgentCompacting(page)).toBe(false);

		// ----- 10. Verify context shows "?" after compaction -----
		// After compaction, _usageStaleAfterCompaction should be true, which
		// shows "?" instead of a stale percentage (matches TUI behaviour).
		const usageStale = await page.evaluate(() => {
			const iface = document.querySelector("agent-interface") as any;
			return iface?.session?._usageStaleAfterCompaction === true;
		});
		expect(usageStale).toBe(true);
		console.log("Usage correctly marked as stale after compaction");

		// Context bar should show "?" (unknown until next response)
		// Wait for the UI to re-render with the stale indicator
		await page.waitForTimeout(2_000);
		const contextUnknown = await page.evaluate(() => {
			const iface = document.querySelector("agent-interface");
			const root = iface?.shadowRoot ?? document;
			const unknownSpan = root.querySelector("span[title*='unknown']");
			return unknownSpan?.textContent?.trim() ?? null;
		});
		console.log(`Context after compaction: "${contextUnknown}"`);
		expect(contextUnknown).toContain("—");

		// ----- 10b. Verify /compact and result messages are preserved -----
		const compactMsgs = await page.evaluate(() => {
			const iface = document.querySelector("agent-interface") as any;
			const msgs = iface?.session?.state?.messages ?? [];
			const compact = msgs.find((m: any) => m.role === "user" && (m.content === "/compact" || (typeof m.content === "string" && m.content.includes("/compact"))));
			const result = msgs.find((m: any) =>
				m.role === "assistant" && Array.isArray(m.content) &&
				m.content.some((c: any) => c.text?.includes("Context compacted"))
			);
			return { hasCompactCmd: !!compact, hasResult: !!result };
		});
		expect(compactMsgs.hasCompactCmd).toBe(true);
		expect(compactMsgs.hasResult).toBe(true);
		console.log("/compact command and result message preserved after refresh");

		// ----- 11. Verify sidebar bobbit is no longer squashed -----
		// Sidebar polls every 5s — wait for the squash to clear.
		await page.waitForFunction(() => {
			const row = document.querySelector(".bg-secondary");
			if (!row) return false;
			const sprites = row.querySelectorAll("span[style*='box-shadow']");
			for (const s of sprites) {
				if ((s.getAttribute("style") || "").includes("scaleY(0.7)")) return false;
			}
			return true;
		}, { timeout: 10_000 });
		console.log("Sidebar bobbit returned to normal");
	});

	test("sidebar stays squashed when navigating away during compaction", async ({ page }) => {
		cleanupSessions(token);
		await openApp(page, token);
		await createNewSession(page);

		await sendAndWaitForResponse(page, "Say exactly: 'Test'. Nothing else.");

		// Trigger compaction
		await sendMessage(page, "/compact");

		// Wait for compaction to start
		{
			const start = Date.now();
			while (Date.now() - start < 10_000) {
				if (await isRemoteAgentCompacting(page)) break;
				await page.waitForTimeout(250);
			}
		}
		expect(await isRemoteAgentCompacting(page)).toBe(true);
		console.log("Compaction started");

		// Get session ID
		const sessionId = await page.evaluate(() =>
			window.location.hash.match(/\/session\/([^/]+)/)?.[1] ?? null
		);
		expect(sessionId).not.toBeNull();

		// Navigate away
		await createNewSession(page);
		await page.waitForTimeout(1_000);

		// Check sidebar: the original session should still show squashed bobbit
		// (server-side isCompacting=true is returned by REST polling)
		{
			const start = Date.now();
			let found = false;
			while (Date.now() - start < 10_000) {
				found = await page.evaluate(() => {
					const rows = document.querySelectorAll(".overflow-y-auto [class*='group']:not(.bg-secondary)");
					for (const row of rows) {
						const sprites = row.querySelectorAll("span[style*='box-shadow']");
						for (const s of sprites) {
							if ((s.getAttribute("style") || "").includes("scaleY(0.7)")) return true;
						}
					}
					return false;
				});
				if (found) break;
				await page.waitForTimeout(500);
			}
			expect(found).toBe(true);
			console.log("Sidebar still squashed after navigating away");
		}

		// Navigate back
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);

		// Wait for reconnect — messages load or compaction state restores
		{
			const start = Date.now();
			while (Date.now() - start < 15_000) {
				const ready = await page.evaluate(() => {
					const iface = document.querySelector("agent-interface") as any;
					const s = iface?.session;
					return (s?.state?.messages?.length > 0) || s?._isCompacting;
				});
				if (ready) break;
				await page.waitForTimeout(250);
			}
		}

		// Either still compacting or already finished — both are valid
		const stillCompacting = await isRemoteAgentCompacting(page);
		const hasCompactedMsg = await page.evaluate(() => {
			const iface = document.querySelector("agent-interface") as any;
			const msgs = iface?.session?.state?.messages ?? [];
			return msgs.some((m: any) =>
				m.role === "assistant" && Array.isArray(m.content) &&
				m.content.some((c: any) => c.text?.includes("Context compacted."))
			);
		});
		const hasPlaceholder = await page.evaluate(() =>
			document.querySelector("message-list")?.textContent?.includes("Compacting context") ?? false
		);
		console.log(`After reconnect: compacting=${stillCompacting}, done=${hasCompactedMsg}, placeholder=${hasPlaceholder}`);

		// If still compacting, wait for it to finish
		if (stillCompacting || hasPlaceholder) {
			console.log("Compaction still in progress after reconnect — waiting");
			await waitForCompactionEnd(page, 120_000);
			console.log("Compaction completed after reconnecting");
		}

		expect(await isRemoteAgentCompacting(page)).toBe(false);
		console.log("Session healthy after navigation round-trip");
	});

	test("page refresh mid-compaction restores compaction animation", async ({ page }) => {
		cleanupSessions(token);
		await openApp(page, token);
		await createNewSession(page);

		await sendAndWaitForResponse(page, "Say exactly: 'Test'. Nothing else.");

		// Trigger compaction
		await sendMessage(page, "/compact");

		// Wait for squashed blob
		await waitForBlobState(page, "compacting", 10_000);
		console.log("Blob is compacting before refresh");

		// Refresh the page (keep the same URL with session hash)
		const url = page.url();
		await page.reload();

		// Wait for app to re-authenticate and reconnect
		await expect(page.locator('button[title="New session"]')).toBeVisible({ timeout: 15_000 });
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// The server sends compaction_start on reconnect; AgentInterface should
		// pick up _isCompacting and start the animation.
		// Wait for the blob to enter a compaction animation state.
		{
			const start = Date.now();
			let foundCompaction = false;
			while (Date.now() - start < 15_000) {
				const state = await getBlobState(page);
				if (state === "compact-shake" || state === "compacting") {
					foundCompaction = true;
					console.log(`Blob restored to "${state}" after refresh`);
					break;
				}
				// Also check if compaction already finished (fast compaction)
				const still = await isRemoteAgentCompacting(page);
				if (!still) {
					console.log("Compaction finished before animation could be checked");
					foundCompaction = true; // compaction completed — that's fine
					break;
				}
				await page.waitForTimeout(250);
			}
			expect(foundCompaction).toBe(true);
		}

		// Verify the placeholder is visible (either compacting or done)
		const hasIndicator = await page.evaluate(() => {
			const ml = document.querySelector("message-list");
			const text = ml?.textContent ?? "";
			return text.includes("Compacting context") || text.includes("Context compacted.");
		});
		expect(hasIndicator).toBe(true);
		console.log("Compaction indicator visible after refresh");

		// Wait for compaction to finish
		await waitForCompactionEnd(page, 120_000);
		expect(await isRemoteAgentCompacting(page)).toBe(false);
		console.log("Compaction completed after page refresh");
	});
});
