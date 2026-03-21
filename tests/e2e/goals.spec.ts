import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for creating, editing, and using goals.
 *
 * Run with:
 *   npx playwright test tests/goals.spec.ts --config tests/playwright-e2e.config.ts
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

/** Navigate to the app with the auth token so it auto-authenticates. */
async function openApp(page: Page, token: string) {
	await page.goto(`/?token=${encodeURIComponent(token)}`);
	// Wait until the authenticated UI appears (sidebar with "Bobbit" heading)
	await expect(page.locator("text=Bobbit").first()).toBeVisible({ timeout: 15_000 });
}

/** REST helper — create a goal via the API directly */
async function apiCreateGoal(
	baseUrl: string,
	token: string,
	data: { title: string; cwd?: string; spec?: string },
): Promise<{ id: string; title: string; cwd: string; state: string; spec: string }> {
	const res = await fetch(`${baseUrl}/api/goals`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	expect(res.status).toBe(201);
	return res.json();
}

/** REST helper — list all goals */
async function apiListGoals(
	baseUrl: string,
	token: string,
): Promise<Array<{ id: string; title: string; cwd: string; state: string; spec: string }>> {
	const res = await fetch(`${baseUrl}/api/goals`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.goals;
}

/** REST helper — get a single goal */
async function apiGetGoal(
	baseUrl: string,
	token: string,
	id: string,
): Promise<{ id: string; title: string; cwd: string; state: string; spec: string }> {
	const res = await fetch(`${baseUrl}/api/goals/${id}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.ok).toBe(true);
	return res.json();
}

/** REST helper — update a goal */
async function apiUpdateGoal(
	baseUrl: string,
	token: string,
	id: string,
	updates: { title?: string; cwd?: string; state?: string; spec?: string },
): Promise<void> {
	const res = await fetch(`${baseUrl}/api/goals/${id}`, {
		method: "PUT",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	});
	expect(res.ok).toBe(true);
}

/** REST helper — delete a goal */
async function apiDeleteGoal(baseUrl: string, token: string, id: string): Promise<void> {
	const res = await fetch(`${baseUrl}/api/goals/${id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.ok).toBe(true);
}

/** REST helper — create a session under a goal */
async function apiCreateSession(
	baseUrl: string,
	token: string,
	goalId?: string,
): Promise<{ id: string; cwd: string; goalId?: string }> {
	const body: any = {};
	if (goalId) body.goalId = goalId;
	const res = await fetch(`${baseUrl}/api/sessions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return res.json();
}

/** REST helper — list sessions */
async function apiListSessions(
	baseUrl: string,
	token: string,
): Promise<Array<{ id: string; goalId?: string; cwd: string }>> {
	const res = await fetch(`${baseUrl}/api/sessions`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	expect(res.ok).toBe(true);
	const data = await res.json();
	return data.sessions;
}

/** REST helper — terminate a session */
async function apiDeleteSession(baseUrl: string, token: string, id: string): Promise<void> {
	await fetch(`${baseUrl}/api/sessions/${id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	});
}

// ---------------------------------------------------------------------------
// REST API tests
// ---------------------------------------------------------------------------

const GW_URL = "http://localhost:3001";

test.describe("Goals — REST API", () => {
	let token: string;
	const createdGoalIds: string[] = [];
	const createdSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test.afterAll(async () => {
		// Clean up sessions first, then goals
		for (const id of createdSessionIds) {
			await apiDeleteSession(GW_URL, token, id).catch(() => {});
		}
		for (const id of createdGoalIds) {
			await apiDeleteGoal(GW_URL, token, id).catch(() => {});
		}
	});

	test("POST /api/goals creates a goal with default state 'todo'", async () => {
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Test Goal Alpha",
			cwd: "/tmp/test-alpha",
			spec: "## Acceptance Criteria\n- It works",
		});
		createdGoalIds.push(goal.id);

		expect(goal.id).toBeTruthy();
		expect(goal.title).toBe("Test Goal Alpha");
		expect(goal.cwd).toBe("/tmp/test-alpha");
		expect(goal.state).toBe("todo");
		expect(goal.spec).toBe("## Acceptance Criteria\n- It works");
	});

	test("POST /api/goals with missing title returns 400", async () => {
		const res = await fetch(`${GW_URL}/api/goals`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: "/tmp" }),
		});
		expect(res.status).toBe(400);
	});

	test("GET /api/goals lists created goals", async () => {
		const goal = await apiCreateGoal(GW_URL, token, { title: "Test Goal Beta" });
		createdGoalIds.push(goal.id);

		const goals = await apiListGoals(GW_URL, token);
		const found = goals.find((g) => g.id === goal.id);
		expect(found).toBeTruthy();
		expect(found!.title).toBe("Test Goal Beta");
	});

	test("GET /api/goals/:id returns a single goal", async () => {
		const created = await apiCreateGoal(GW_URL, token, {
			title: "Test Goal Gamma",
			spec: "Some spec",
		});
		createdGoalIds.push(created.id);

		const goal = await apiGetGoal(GW_URL, token, created.id);
		expect(goal.title).toBe("Test Goal Gamma");
		expect(goal.spec).toBe("Some spec");
	});

	test("GET /api/goals/:id returns 404 for nonexistent goal", async () => {
		const res = await fetch(`${GW_URL}/api/goals/nonexistent-id`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	test("PUT /api/goals/:id updates title, state, and spec", async () => {
		const created = await apiCreateGoal(GW_URL, token, { title: "Before Update" });
		createdGoalIds.push(created.id);

		await apiUpdateGoal(GW_URL, token, created.id, {
			title: "After Update",
			state: "in-progress",
			spec: "Updated spec content",
		});

		const goal = await apiGetGoal(GW_URL, token, created.id);
		expect(goal.title).toBe("After Update");
		expect(goal.state).toBe("in-progress");
		expect(goal.spec).toBe("Updated spec content");
	});

	test("PUT /api/goals/:id returns 404 for nonexistent goal", async () => {
		const res = await fetch(`${GW_URL}/api/goals/nonexistent-id`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ title: "Nope" }),
		});
		expect(res.status).toBe(404);
	});

	test("DELETE /api/goals/:id removes the goal", async () => {
		const created = await apiCreateGoal(GW_URL, token, { title: "To Be Deleted" });

		await apiDeleteGoal(GW_URL, token, created.id);

		const goals = await apiListGoals(GW_URL, token);
		expect(goals.find((g) => g.id === created.id)).toBeUndefined();
	});

	test("creating a session under a goal links them and uses goal's cwd", async () => {
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Session CWD Test",
			cwd: process.cwd(), // use a real directory so the agent can start
		});
		createdGoalIds.push(goal.id);

		const session = await apiCreateSession(GW_URL, token, goal.id);
		createdSessionIds.push(session.id);

		expect(session.goalId).toBe(goal.id);
		expect(session.cwd).toBe(process.cwd());

		// Verify via list
		const sessions = await apiListSessions(GW_URL, token);
		const found = sessions.find((s) => s.id === session.id);
		expect(found).toBeTruthy();
		expect(found!.goalId).toBe(goal.id);
	});

	test("creating a session under a 'todo' goal transitions it to 'in-progress'", async () => {
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Auto Transition Test",
			cwd: process.cwd(),
		});
		createdGoalIds.push(goal.id);
		expect(goal.state).toBe("todo");

		const session = await apiCreateSession(GW_URL, token, goal.id);
		createdSessionIds.push(session.id);

		// Goal should now be in-progress
		const updated = await apiGetGoal(GW_URL, token, goal.id);
		expect(updated.state).toBe("in-progress");
	});

	test("creating a session without a goal has no goalId", async () => {
		const session = await apiCreateSession(GW_URL, token);
		createdSessionIds.push(session.id);

		const sessions = await apiListSessions(GW_URL, token);
		const found = sessions.find((s) => s.id === session.id);
		expect(found).toBeTruthy();
		expect(found!.goalId).toBeUndefined();
	});

	test("goal spec generates a combined system prompt file", async () => {
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Spec Injection Test",
			cwd: process.cwd(),
			spec: "Always respond with 'GOAL_SPEC_INJECTED' as the first word.",
		});
		createdGoalIds.push(goal.id);

		// Verify the combined prompt file was generated
		const promptPath = path.join(os.homedir(), ".pi", "goal-prompts", `${goal.id}.md`);
		// The file is created lazily when a session requests it, so trigger it
		// by creating a session
		const session = await apiCreateSession(GW_URL, token, goal.id);
		createdSessionIds.push(session.id);

		// Give it a moment to start
		await new Promise((r) => setTimeout(r, 2000));

		expect(fs.existsSync(promptPath)).toBe(true);
		const content = fs.readFileSync(promptPath, "utf-8");
		expect(content).toContain("GOAL_SPEC_INJECTED");
		expect(content).toContain("Spec Injection Test");
	});

	test("deleting a goal does not delete its sessions", async () => {
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Delete Goal Keep Sessions",
			cwd: process.cwd(),
		});

		const session = await apiCreateSession(GW_URL, token, goal.id);
		createdSessionIds.push(session.id);

		await apiDeleteGoal(GW_URL, token, goal.id);

		// Session should still exist
		const sessions = await apiListSessions(GW_URL, token);
		const found = sessions.find((s) => s.id === session.id);
		expect(found).toBeTruthy();
	});

	test("goal state cycle: todo → in-progress → complete → shelved", async () => {
		const goal = await apiCreateGoal(GW_URL, token, { title: "State Cycle Test" });
		createdGoalIds.push(goal.id);

		expect(goal.state).toBe("todo");

		await apiUpdateGoal(GW_URL, token, goal.id, { state: "in-progress" });
		expect((await apiGetGoal(GW_URL, token, goal.id)).state).toBe("in-progress");

		await apiUpdateGoal(GW_URL, token, goal.id, { state: "complete" });
		expect((await apiGetGoal(GW_URL, token, goal.id)).state).toBe("complete");

		await apiUpdateGoal(GW_URL, token, goal.id, { state: "shelved" });
		expect((await apiGetGoal(GW_URL, token, goal.id)).state).toBe("shelved");

		// Can go back to todo
		await apiUpdateGoal(GW_URL, token, goal.id, { state: "todo" });
		expect((await apiGetGoal(GW_URL, token, goal.id)).state).toBe("todo");
	});
});

// ---------------------------------------------------------------------------
// UI tests
// ---------------------------------------------------------------------------

test.describe("Goals — UI", () => {
	test.setTimeout(120_000);

	let token: string;
	const cleanupGoalIds: string[] = [];
	const cleanupSessionIds: string[] = [];

	test.beforeAll(() => {
		token = readGatewayToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupSessionIds) {
			await apiDeleteSession(GW_URL, token, id).catch(() => {});
		}
		for (const id of cleanupGoalIds) {
			await apiDeleteGoal(GW_URL, token, id).catch(() => {});
		}
	});

	test("clicking 'New goal' opens a goal assistant chat session", async ({ page }) => {
		await openApp(page, token);

		// Click the "New goal" button (crosshair icon) in the sidebar header
		await page.locator('button[title="New goal"]').click();

		// Should connect to a goal assistant session (message editor appears)
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// The session title should be "Goal Assistant"
		await expect(page.locator("text=Goal Assistant").first()).toBeVisible({ timeout: 5_000 });

		// Clean up: terminate the goal assistant session
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal appears in sidebar and can be expanded", async ({ page }) => {
		// Create a goal via API
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Expandable Goal",
			cwd: process.cwd(),
		});
		cleanupGoalIds.push(goal.id);

		await openApp(page, token);

		// Goal should appear in the sidebar
		const goalRow = page.locator("text=Expandable Goal").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });

		// Click to expand
		await goalRow.click();

		// Should see "No sessions" message since the goal has no sessions
		await expect(page.locator("text=No sessions").first()).toBeVisible({ timeout: 5_000 });
	});

	test("can create a session under a goal via the sidebar", async ({ page }) => {
		// Create a goal via API
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Session Under Goal",
			cwd: process.cwd(),
		});
		cleanupGoalIds.push(goal.id);

		await openApp(page, token);

		// Find and expand the goal
		const goalRow = page.locator("text=Session Under Goal").first();
		await expect(goalRow).toBeVisible({ timeout: 10_000 });
		await goalRow.click();

		// Click "start one" link inside the expanded goal
		await page.locator("text=start one").first().click();

		// Wait for the session to connect (message editor appears)
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Clean up: find the session that was created
		const sessions = await apiListSessions(GW_URL, token);
		const goalSession = sessions.find((s) => s.goalId === goal.id);
		if (goalSession) cleanupSessionIds.push(goalSession.id);
	});

	test("goal assistant session auto-prompts and agent responds with greeting", async ({ page }) => {
		await openApp(page, token);

		// Click the "New goal" button — this creates a goal assistant session
		await page.locator('button[title="New goal"]').click();

		// Wait for the session to connect (message editor appears)
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// The auto-prompt should have been sent. Wait for the agent's greeting
		// response to appear in the message list. The agent should mention
		// goal creation or ask what the user wants to achieve.
		const messageList = page.locator("message-list");
		await expect(messageList).toBeVisible({ timeout: 10_000 });

		// Wait for at least one assistant message to appear (the greeting).
		// The agent's response should contain goal-related language.
		const assistantMessage = messageList.locator(".message-assistant, [data-role='assistant']").first();
		await expect(assistantMessage).toBeVisible({ timeout: 60_000 });

		// Verify the greeting content mentions goal creation or achieving something
		const messageText = await messageList.innerText();
		const hasGoalLanguage = /goal|achieve|want to|help you/i.test(messageText);
		expect(hasGoalLanguage).toBe(true);

		// Clean up: terminate the goal assistant session
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant shows split-screen preview panel on desktop", async ({ page }) => {
		await openApp(page, token);

		// Click "New goal" to create a goal assistant session
		await page.locator('button[title="New goal"]').click();

		// Wait for the session to connect
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// The preview panel should be visible with the placeholder state
		const previewPanel = page.locator(".goal-preview-panel");
		await expect(previewPanel).toBeVisible({ timeout: 5_000 });

		// Should show the placeholder text before any proposal is received
		await expect(previewPanel.locator("text=Chat with the assistant")).toBeVisible({ timeout: 5_000 });

		// ChatPanel should also be visible (split-screen)
		await expect(page.locator("chat-panel")).toBeVisible();

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant preview panel populates when proposal is received", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Wait for the agent greeting first
		const messageList = page.locator("message-list");
		await expect(messageList).toBeVisible({ timeout: 10_000 });

		// Ask the agent to propose a goal — this should trigger a <goal_proposal> block
		const textarea = page.locator("message-editor textarea");
		await textarea.fill("I want to add a README.md file to the project. Just propose the goal immediately, no questions.");
		await textarea.press("Enter");

		// Wait for the preview panel to populate with the proposal
		const previewPanel = page.locator(".goal-preview-panel");
		await expect(previewPanel).toBeVisible({ timeout: 10_000 });

		// The title input should have a value (from the proposal)
		const titleInput = previewPanel.locator("input").first();
		await expect(titleInput).toHaveValue(/.+/, { timeout: 120_000 });

		// The "Create Goal" button should be visible
		await expect(previewPanel.locator("text=Create Goal")).toBeVisible();

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant preview panel allows editing fields", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Ask the agent to propose a goal
		const textarea = page.locator("message-editor textarea");
		await textarea.fill("I want to write unit tests. Propose the goal right away without asking questions.");
		await textarea.press("Enter");

		// Wait for proposal to arrive in the preview panel
		const previewPanel = page.locator(".goal-preview-panel");
		const titleInput = previewPanel.locator("input").first();
		await expect(titleInput).toHaveValue(/.+/, { timeout: 120_000 });

		// Edit the title
		await titleInput.fill("My Custom Title");

		// Edit the working directory
		const cwdInput = previewPanel.locator("input").nth(1);
		await cwdInput.fill("/tmp/custom-cwd");

		// Toggle to edit mode for the spec
		await previewPanel.locator("text=Edit").click();

		// The spec textarea should be visible in edit mode
		const specTextarea = previewPanel.locator("textarea");
		await expect(specTextarea).toBeVisible({ timeout: 3_000 });
		await specTextarea.fill("Custom spec content");

		// Verify the values are preserved
		await expect(titleInput).toHaveValue("My Custom Title");
		await expect(cwdInput).toHaveValue("/tmp/custom-cwd");

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant mobile shows tab bar with Chat and Preview tabs", async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });
		await openApp(page, token);

		// Create goal assistant session — on mobile, click "Goal" button in the landing page
		const goalBtn = page.locator("text=Goal").first();
		await goalBtn.click();

		// Wait for the session to connect
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Tab bar should be visible with Chat and Preview tabs
		const tabBar = page.locator(".goal-tab-bar");
		await expect(tabBar).toBeVisible({ timeout: 5_000 });

		const chatTab = tabBar.locator("text=Chat");
		const previewTab = tabBar.locator("text=Preview");
		await expect(chatTab).toBeVisible();
		await expect(previewTab).toBeVisible();

		// Chat tab should be active by default
		await expect(chatTab).toHaveClass(/goal-tab-pill--active/);
		await expect(previewTab).not.toHaveClass(/goal-tab-pill--active/);

		// Click Preview tab — should show the preview panel placeholder
		await previewTab.click();
		await expect(page.locator(".goal-preview-panel")).toBeVisible({ timeout: 3_000 });
		await expect(page.locator("text=Chat with the assistant")).toBeVisible();

		// Click Chat tab — should show the chat panel again
		await chatTab.click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 3_000 });

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant 'Create Goal' button creates goal and terminates session", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Ask the agent to propose a goal
		const textarea = page.locator("message-editor textarea");
		await textarea.fill("I want to refactor the CSS. Propose the goal immediately, no questions.");
		await textarea.press("Enter");

		// Wait for proposal in preview panel
		const previewPanel = page.locator(".goal-preview-panel");
		const titleInput = previewPanel.locator("input").first();
		await expect(titleInput).toHaveValue(/.+/, { timeout: 120_000 });

		// Override title for easy identification
		await titleInput.fill("E2E Created Goal");

		// Click "Create Goal"
		await previewPanel.locator("button").filter({ hasText: "Create Goal" }).click();

		// Should return to the landing page / session list
		await expect(page.locator("text=Bobbit").first()).toBeVisible({ timeout: 10_000 });

		// The goal should exist via API
		const goals = await apiListGoals(GW_URL, token);
		const created = goals.find((g) => g.title === "E2E Created Goal");
		expect(created).toBeTruthy();
		if (created) cleanupGoalIds.push(created.id);

		// The assistant session should have been terminated
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		expect(assistantSession).toBeUndefined();
	});

	test("goal assistant 'Cancel' button returns to session list", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// The preview panel should have a Cancel button
		const previewPanel = page.locator(".goal-preview-panel");
		await expect(previewPanel).toBeVisible({ timeout: 5_000 });

		// Click Cancel
		await previewPanel.locator("button").filter({ hasText: "Cancel" }).click();

		// Should return to session list (no active session)
		await expect(page.locator("message-editor textarea")).not.toBeVisible({ timeout: 5_000 });

		// Clean up any leftover assistant session
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant split-screen: both panels fit within viewport on desktop", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Verify sidebar, chat panel, and preview panel are all visible
		const sidebar = page.locator(".sidebar-edge").first();
		const chatPanel = page.locator(".goal-chat-panel");
		const previewPanel = page.locator(".goal-preview-panel");
		await expect(sidebar).toBeVisible({ timeout: 5_000 });
		await expect(chatPanel).toBeVisible();
		await expect(previewPanel).toBeVisible();

		const sidebarBox = await sidebar.boundingBox();
		const chatBox = await chatPanel.boundingBox();
		const previewBox = await previewPanel.boundingBox();
		expect(sidebarBox).toBeTruthy();
		expect(chatBox).toBeTruthy();
		expect(previewBox).toBeTruthy();

		// Chat panel must start after the sidebar
		expect(chatBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width - 2);

		// Preview panel right edge must not exceed the viewport
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(1282);

		// Both panels should be roughly equal width (within 5px for border)
		expect(Math.abs(chatBox!.width - previewBox!.width)).toBeLessThan(5);

		// No horizontal scrollbar on the page
		const hasHScroll = await page.evaluate(() =>
			document.documentElement.scrollWidth > document.documentElement.clientWidth);
		expect(hasHScroll).toBe(false);

		await page.screenshot({ path: "test-results/goal-split-empty-e2e.png", fullPage: false });

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant split-screen: preview stays on-screen after proposal populates", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page, token);

		// Create goal assistant session and get a proposal
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		const textarea = page.locator("message-editor textarea");
		await textarea.fill("I want to build a CLI tool that generates changelog entries from git commits. Propose the goal immediately, no questions.");
		await textarea.press("Enter");

		// Wait for proposal to populate the preview panel
		const previewPanel = page.locator(".goal-preview-panel");
		const titleInput = previewPanel.locator("input[type='text']").first();
		await expect(titleInput).toHaveValue(/.+/, { timeout: 120_000 });

		// Take screenshot of the populated state
		await page.screenshot({ path: "test-results/goal-split-populated-e2e.png", fullPage: false });

		// Verify layout bounds after real content has rendered
		const chatBox = await page.locator(".goal-chat-panel").boundingBox();
		const previewBox = await previewPanel.boundingBox();
		expect(chatBox).toBeTruthy();
		expect(previewBox).toBeTruthy();

		// Preview must not overflow the viewport
		expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(1282);

		// Panels should be roughly equal
		expect(Math.abs(chatBox!.width - previewBox!.width)).toBeLessThan(5);

		// No horizontal scroll
		const hasHScroll = await page.evaluate(() =>
			document.documentElement.scrollWidth > document.documentElement.clientWidth);
		expect(hasHScroll).toBe(false);

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant: cwd combobox shows dropdown and supports keyboard navigation", async ({ page }) => {
		// Pre-create a session so there's at least one cwd in the history
		const session = await apiCreateSession(GW_URL, token);
		cleanupSessionIds.push(session.id);

		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Find the cwd combobox input (inside the preview panel)
		const previewPanel = page.locator(".goal-preview-panel");
		await expect(previewPanel).toBeVisible({ timeout: 5_000 });

		const cwdInput = previewPanel.locator(".cwd-combobox input[type='text']");
		await expect(cwdInput).toBeVisible();

		// Focus the input — dropdown should appear if there are recent cwds
		await cwdInput.focus();
		// Give the dropdown a moment to render
		await page.waitForTimeout(300);

		const dropdown = previewPanel.locator(".cwd-combobox-dropdown");
		const dropdownVisible = await dropdown.isVisible().catch(() => false);

		if (dropdownVisible) {
			// Dropdown has ARIA listbox role
			await expect(dropdown).toHaveAttribute("role", "listbox");

			// Input has combobox ARIA
			await expect(cwdInput).toHaveAttribute("role", "combobox");

			// ArrowDown highlights first item
			await cwdInput.press("ArrowDown");
			const firstItem = dropdown.locator("[role='option']").first();
			await expect(firstItem).toHaveAttribute("data-highlighted", "");

			// Enter selects the highlighted item
			const itemText = await firstItem.locator(".cwd-path").textContent();
			await cwdInput.press("Enter");

			// Input should now contain the selected path
			if (itemText) {
				await expect(cwdInput).toHaveValue(itemText.trim());
			}

			// Dropdown should close after selection
			await expect(dropdown).not.toBeVisible({ timeout: 2_000 });
		}

		// Verify the input still accepts free-text typing
		await cwdInput.fill("/some/custom/path");
		await expect(cwdInput).toHaveValue("/some/custom/path");

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant: worktree toggle present and auto-enables with team", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		const previewPanel = page.locator(".goal-preview-panel");
		await expect(previewPanel).toBeVisible({ timeout: 5_000 });

		// Find the worktree toggle (toggle-switch inside the cwd section)
		const worktreeToggle = previewPanel.locator(".toggle-switch").first();
		await expect(worktreeToggle).toBeVisible();
		expect(await worktreeToggle.isChecked()).toBe(false);

		// Find the team toggle (second toggle-switch)
		const teamToggle = previewPanel.locator(".toggle-switch").nth(1);
		await expect(teamToggle).toBeVisible();

		// Enable team — worktree should auto-enable
		await teamToggle.click();
		expect(await teamToggle.isChecked()).toBe(true);
		expect(await worktreeToggle.isChecked()).toBe(true);

		// Worktree can still be independently disabled
		await worktreeToggle.click();
		expect(await worktreeToggle.isChecked()).toBe(false);
		expect(await teamToggle.isChecked()).toBe(true);

		// Clean up
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("goal assistant: worktree flag passes through to API on goal creation", async ({ page }) => {
		await openApp(page, token);

		// Create goal assistant session
		await page.locator('button[title="New goal"]').click();
		await expect(page.locator("message-editor textarea")).toBeVisible({ timeout: 15_000 });

		// Ask for a proposal
		const textarea = page.locator("message-editor textarea");
		await textarea.fill("I want to lint the codebase. Propose the goal right away.");
		await textarea.press("Enter");

		const previewPanel = page.locator(".goal-preview-panel");
		const titleInput = previewPanel.locator("input[type='text']").first();
		await expect(titleInput).toHaveValue(/.+/, { timeout: 120_000 });

		// Override title for identification
		await titleInput.fill("Worktree Flag Test");

		// Enable worktree toggle
		const worktreeToggle = previewPanel.locator(".toggle-switch").first();
		await worktreeToggle.click();
		expect(await worktreeToggle.isChecked()).toBe(true);

		// Create the goal
		await previewPanel.locator("button").filter({ hasText: "Create Goal" }).click();
		await expect(page.locator("text=Bobbit").first()).toBeVisible({ timeout: 10_000 });

		// Verify the goal was created — if the cwd is a git repo, it should have a worktreePath
		const goals = await apiListGoals(GW_URL, token);
		const created = goals.find((g) => g.title === "Worktree Flag Test");
		expect(created).toBeTruthy();
		if (created) {
			cleanupGoalIds.push(created.id);
			// If the goal's cwd was a git repo, worktreePath should be set
			// (the test project cwd IS a git repo)
			const goalDetail = await apiGetGoal(GW_URL, token, created.id);
			expect((goalDetail as any).worktreePath).toBeTruthy();
			expect((goalDetail as any).branch).toMatch(/^goal\//);
		}

		// Clean up sessions
		const sessions = await apiListSessions(GW_URL, token);
		const assistantSession = sessions.find((s: any) => s.assistantType === "goal" || s.goalAssistant);
		if (assistantSession) cleanupSessionIds.push(assistantSession.id);
	});

	test("can edit a goal via the UI dialog", async ({ page }) => {
		// Create a goal via API
		const goal = await apiCreateGoal(GW_URL, token, {
			title: "Goal To Edit",
			cwd: process.cwd(),
			spec: "Original spec",
		});
		cleanupGoalIds.push(goal.id);

		await openApp(page, token);

		// Find the goal in the sidebar, hover to reveal edit button
		const goalText = page.locator("text=Goal To Edit").first();
		await expect(goalText).toBeVisible({ timeout: 10_000 });

		// Hover over the goal row to reveal action buttons
		const goalParent = goalText.locator("..").locator("..");
		await goalParent.hover();

		// Click the edit (pencil) button
		const editBtn = goalParent.locator('button[title="Edit goal"]');
		await expect(editBtn).toBeVisible({ timeout: 3_000 });
		await editBtn.click();

		// Dialog should appear with "Edit Goal" title
		const dialog = page.locator(".fixed.z-50.bg-background").filter({ hasText: "Edit Goal" });
		await expect(dialog).toBeVisible({ timeout: 5_000 });

		// Change the title
		const titleInput = dialog.locator("input").first();
		await titleInput.fill("Edited Goal Title");

		// Change the state to "Complete"
		await dialog.getByRole("button", { name: "Complete" }).click();

		// Save
		await dialog.getByRole("button", { name: "Save" }).click();
		await expect(dialog).not.toBeVisible({ timeout: 5_000 });

		// Verify the title changed in the sidebar
		await expect(page.locator("text=Edited Goal Title").first()).toBeVisible({ timeout: 5_000 });

		// Verify via API that state changed
		const updated = await apiGetGoal(GW_URL, token, goal.id);
		expect(updated.title).toBe("Edited Goal Title");
		expect(updated.state).toBe("complete");
	});
});
