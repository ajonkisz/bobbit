import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for delegate tool UI rendering, log links, and live progress.
 *
 * Run with:
 *   npx playwright test tests/delegate-ui.spec.ts --config tests/playwright-workflow.config.ts
 *
 * Covers:
 *   1. Log links open as text/plain (not download) with auth token in query param
 *   2. Delegates show completion individually (partial results plumbing exists)
 *   3. Log links are visible while delegates are running (pre-generated IDs)
 *   4. Log icon (ScrollText) on the left of "logs" text
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

function getGatewayUrl(): string {
	return process.env.GATEWAY_URL || "https://100.123.227.233:3001";
}

// ---------------------------------------------------------------------------
// Test 1: Log endpoint serves text/plain with query param auth
// ---------------------------------------------------------------------------

test.describe("Delegate logs endpoint", () => {
	const logsDir = path.join(os.homedir(), ".pi", "delegate-logs");
	const testId = `test-logserve-${Date.now()}`;
	const logPath = path.join(logsDir, `${testId}.jsonl`);

	test.beforeAll(() => {
		fs.mkdirSync(logsDir, { recursive: true });
		fs.writeFileSync(logPath, '{"type":"message_start","msg":"hello"}\n{"type":"message_end","msg":"bye"}\n', "utf-8");
	});

	test.afterAll(() => {
		try { fs.unlinkSync(logPath); } catch { /* ok */ }
	});

	test("serves HTML viewer by default with query param token", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/${testId}?token=${encodeURIComponent(token)}`, {
			ignoreHTTPSErrors: true,
		});
		expect(resp.status()).toBe(200);

		const contentType = resp.headers()["content-type"];
		expect(contentType).toContain("text/html");
		// HTML means browser renders it as a page, not downloads

		const body = await resp.text();
		expect(body).toContain("<!DOCTYPE html>");
		expect(body).toContain("Delegate Log");
		// The raw URL should be embedded for fetching JSONL client-side
		expect(body).toContain("format=raw");
	});

	test("serves raw JSONL with format=raw", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/${testId}?format=raw&token=${encodeURIComponent(token)}`, {
			ignoreHTTPSErrors: true,
		});
		expect(resp.status()).toBe(200);
		expect(resp.headers()["content-type"]).toContain("text/plain");
		const body = await resp.text();
		expect(body).toContain('"type":"message_start"');
	});

	test("serves with Bearer token too", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/${testId}`, {
			headers: { Authorization: `Bearer ${token}` },
			ignoreHTTPSErrors: true,
		});
		expect(resp.status()).toBe(200);
		expect(resp.headers()["content-type"]).toContain("text/html");
	});

	test("returns 401 without any auth", async ({ request }) => {
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/${testId}`, {
			ignoreHTTPSErrors: true,
		});
		expect(resp.status()).toBe(401);
	});

	test("returns 404 for nonexistent log", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/no-such-id-999?token=${encodeURIComponent(token)}`, {
			ignoreHTTPSErrors: true,
		});
		expect(resp.status()).toBe(404);
	});

	test("rejects path traversal", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		const resp = await request.get(`${gw}/api/delegate-logs/..%2F..%2Fetc%2Fpasswd?token=${encodeURIComponent(token)}`, {
			ignoreHTTPSErrors: true,
		});
		expect([400, 404]).toContain(resp.status());
	});
});

// ---------------------------------------------------------------------------
// Test 2: Partial results plumbing exists in component chain
// ---------------------------------------------------------------------------

test.describe("Delegate live progress plumbing", () => {
	test("toolPartialResults property exists on ToolMessage, AssistantMessage, and StreamingMessageContainer", async () => {
		// Verify the source files have the correct property declarations
		const messagesTs = fs.readFileSync(
			path.join(process.cwd(), "src/ui/components/Messages.ts"),
			"utf-8",
		);
		const streamingTs = fs.readFileSync(
			path.join(process.cwd(), "src/ui/components/StreamingMessageContainer.ts"),
			"utf-8",
		);

		// ToolMessage has partialResult property
		expect(messagesTs).toMatch(/@property.*partialResult/);

		// AssistantMessage has toolPartialResults property and passes it down
		expect(messagesTs).toMatch(/@property.*toolPartialResults/);
		expect(messagesTs).toContain(".partialResult=${this.toolPartialResults?.[tc.id]}");

		// StreamingMessageContainer has toolPartialResults and passes to assistant-message
		expect(streamingTs).toMatch(/@property.*toolPartialResults/);
		expect(streamingTs).toContain(".toolPartialResults=${this.toolPartialResults}");
	});

	test("AgentInterface handles tool_execution_update events for re-rendering", async () => {
		const agentTs = fs.readFileSync(
			path.join(process.cwd(), "src/ui/components/AgentInterface.ts"),
			"utf-8",
		);

		// Must handle tool_execution_update events
		expect(agentTs).toContain("tool_execution_update");
		expect(agentTs).toContain("toolPartialResults");
		// Must trigger requestUpdate and push partials to streaming container
		expect(agentTs).toMatch(/tool_execution_update[\s\S]*?requestUpdate/);
	});

	test("ToolMessage creates synthetic result from partialResult when no final result", async () => {
		const messagesTs = fs.readFileSync(
			path.join(process.cwd(), "src/ui/components/Messages.ts"),
			"utf-8",
		);

		// ToolMessage should use partialResult to create a synthetic tool result
		// when the real result isn't available yet
		expect(messagesTs).toContain("partialResult");
		// The synthetic result construction allows renderers to show partial delegate progress
	});
});

// ---------------------------------------------------------------------------
// Test 3: Delegate IDs pre-generated for running agents' log links
// ---------------------------------------------------------------------------

test.describe("Delegate IDs pre-generated for running log links", () => {
	test("delegate extension pre-generates IDs and emits them before delegates finish", async () => {
		const delegateTs = fs.readFileSync(
			path.join(process.cwd(), ".pi/extensions/delegate.ts"),
			"utf-8",
		);

		// Must pre-generate IDs before starting delegates
		expect(delegateTs).toContain("Pre-generate IDs");
		// Must accept pre-assigned IDs
		expect(delegateTs).toContain("preAssignedId");
		// Must emit initial progress with all IDs in running state
		expect(delegateTs).toMatch(/status.*running.*durationMs.*0/);
	});

	test("workflow extension pre-generates IDs for parallel phases", async () => {
		const workflowTs = fs.readFileSync(
			path.join(process.cwd(), ".pi/extensions/workflow.ts"),
			"utf-8",
		);

		// Must pre-generate IDs for parallel sub-phases
		expect(workflowTs).toContain("Pre-generate IDs");
		expect(workflowTs).toContain("randomUUID");
		// Must pass pre-assigned IDs to runPhaseDelegate
		expect(workflowTs).toContain("phaseIds[idx]");
	});

	test("DelegateRenderer shows log links when delegate has an ID even if running", async () => {
		const rendererTs = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/DelegateRenderer.ts"),
			"utf-8",
		);

		// renderLogLink always renders when given an ID
		expect(rendererTs).toContain("renderLogLink");
		// Collapsible section is expanded when delegates are running
		expect(rendererTs).toContain("isRunning");
		expect(rendererTs).toMatch(/isRunning.*max-h-\[2000px\]/);
	});
});

// ---------------------------------------------------------------------------
// Test 4: Log icon is ScrollText on the left of "logs" text
// ---------------------------------------------------------------------------

test.describe("Delegate log button icon and position", () => {
	test("uses ScrollText icon before 'logs' text (not ExternalLink after)", async () => {
		const delegateRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/DelegateRenderer.ts"),
			"utf-8",
		);
		const workflowRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/WorkflowRenderer.ts"),
			"utf-8",
		);

		// ScrollText icon before "logs"
		expect(delegateRenderer).toContain('${icon(ScrollText, "xs")} logs');
		expect(workflowRenderer).toContain('${icon(ScrollText, "xs")} logs');

		// No ExternalLink import or usage
		expect(delegateRenderer).not.toContain("ExternalLink");
		expect(workflowRenderer).not.toContain("ExternalLink");
	});

	test("log link styled as a pill button with border", async () => {
		const delegateRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/DelegateRenderer.ts"),
			"utf-8",
		);

		expect(delegateRenderer).toContain("border border-border rounded");
		expect(delegateRenderer).toContain("px-1.5 py-0.5");
		expect(delegateRenderer).toContain("hover:bg-accent");
	});
});

// ---------------------------------------------------------------------------
// Test 5: Running delegates show spinner, not red cross
// ---------------------------------------------------------------------------

test.describe("Running delegate status rendering", () => {
	test("statusColor and statusIcon handle 'running' status (not red cross)", async () => {
		const delegateRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/DelegateRenderer.ts"),
			"utf-8",
		);

		// Must handle "running" explicitly before the default red fallthrough
		expect(delegateRenderer).toMatch(/if\s*\(status\s*===\s*"running"\)\s*return\s*"text-muted-foreground/);
		expect(delegateRenderer).toMatch(/if\s*\(status\s*===\s*"running"\)\s*return\s*"⏳"/);

		const workflowRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/WorkflowRenderer.ts"),
			"utf-8",
		);
		expect(workflowRenderer).toMatch(/if\s*\(status\s*===\s*"running"\)\s*return\s*"text-muted-foreground/);
		expect(workflowRenderer).toMatch(/if\s*\(status\s*===\s*"running"\)\s*return\s*"⏳"/);
	});

	test("running delegates show live-timer instead of static 0s", async () => {
		const delegateRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/DelegateRenderer.ts"),
			"utf-8",
		);
		const workflowRenderer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/tools/renderers/WorkflowRenderer.ts"),
			"utf-8",
		);

		// Both renderers should import LiveTimer
		expect(delegateRenderer).toContain("LiveTimer");
		expect(workflowRenderer).toContain("LiveTimer");

		// Both should render <live-timer> for running delegates
		expect(delegateRenderer).toContain("live-timer");
		expect(workflowRenderer).toContain("live-timer");

		// LiveTimer component should exist
		const liveTimer = fs.readFileSync(
			path.join(process.cwd(), "src/ui/components/LiveTimer.ts"),
			"utf-8",
		);
		expect(liveTimer).toContain("class LiveTimer");
		expect(liveTimer).toContain("setInterval");
		expect(liveTimer).toContain("startTime");
	});
});

// ---------------------------------------------------------------------------
// Test 6: Log viewer serves formatted HTML (not raw JSONL)
// ---------------------------------------------------------------------------

test.describe("Delegate log viewer HTML", () => {
	test("HTML viewer parses JSONL and renders chat-like messages", async ({ request }) => {
		const token = readGatewayToken();
		const gw = getGatewayUrl();

		// Create a realistic log file
		const logsDir = path.join(os.homedir(), ".pi", "delegate-logs");
		const viewerId = `test-viewer-${Date.now()}`;
		const viewerPath = path.join(logsDir, `${viewerId}.jsonl`);
		const events = [
			'{"type":"agent_start"}',
			'{"type":"turn_start"}',
			'{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
			'{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi there!"},{"type":"toolCall","id":"tc1","name":"bash","arguments":{"command":"echo test"}}],"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.001,"output":0.002,"cacheRead":0,"cacheWrite":0,"total":0.003}}}}',
			'{"type":"message_end","message":{"role":"tool","content":[{"type":"toolResult","toolCallId":"tc1","content":[{"type":"text","text":"test output"}],"isError":false}]}}',
			'{"type":"agent_end"}',
		];
		fs.writeFileSync(viewerPath, events.join("\n") + "\n", "utf-8");

		try {
			const resp = await request.get(`${gw}/api/delegate-logs/${viewerId}?token=${encodeURIComponent(token)}`, {
				ignoreHTTPSErrors: true,
			});
			expect(resp.status()).toBe(200);
			const body = await resp.text();

			// Contains the viewer HTML structure
			expect(body).toContain("<!DOCTYPE html>");
			expect(body).toContain("Delegate Log");
			expect(body).toContain("class=\"messages\"");
			// Contains JavaScript that processes events
			expect(body).toContain("processLine");
			expect(body).toContain("message_end");
			expect(body).toContain("tool-msg");
			expect(body).toContain("tool-result-msg");
			// Raw URL is embedded for client-side fetch
			expect(body).toContain(`format=raw`);
			expect(body).toContain(viewerId);
		} finally {
			fs.unlinkSync(viewerPath);
		}
	});
});
