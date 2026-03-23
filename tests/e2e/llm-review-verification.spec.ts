import { test, expect } from "@playwright/test";
import { readE2EToken, BASE } from "./e2e-setup.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

async function createGoalWithWorkflow(workflowId: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `LLM Review Test ${Date.now()}`,
			cwd: process.cwd(),
			team: false,
			workflowId,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return goal.id;
}

async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
}

/**
 * Poll until a gate reaches one of the target statuses or timeout expires.
 */
async function waitForGateAnyStatus(
	goalId: string,
	gateId: string,
	targetStatuses: string[],
	timeoutMs = 120_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (targetStatuses.includes(data.status)) return data;
		await new Promise(r => setTimeout(r, 2000));
	}
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach any of [${targetStatuses}] within ${timeoutMs}ms. Current: "${data.status}"`,
	);
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("LLM Review Verification", () => {
	// Sub-agent spawning can take a while
	test.setTimeout(180_000);

	test("llm-review step spawns real sub-agent (not auto-pass stub)", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			// Signal the design-doc gate which has an llm-review verification step
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: implement feature X\n\nFiles: src/x.ts\n\nCriteria: passes tests",
				}),
			});
			expect(signalResp.status).toBe(201);
			const signalData = await signalResp.json();
			expect(signalData.signal.status).toBe("running");

			// Wait for gate to reach passed or failed — either is valid,
			// the key assertion is that the auto-pass stub text is gone
			const gate = await waitForGateAnyStatus(goalId, "design-doc", ["passed", "failed"]);

			// Fetch the signal details to inspect verification step output
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signals`);
			expect(signalsResp.status).toBe(200);
			const { signals } = await signalsResp.json();
			expect(signals.length).toBeGreaterThan(0);

			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toMatch(/^(passed|failed)$/);
			expect(lastSignal.verification.steps.length).toBeGreaterThan(0);

			// The critical assertion: the auto-pass stub text must NOT appear
			const reviewStep = lastSignal.verification.steps.find(
				(s: any) => s.type === "llm-review",
			);
			expect(reviewStep).toBeTruthy();
			expect(reviewStep.output).not.toContain("auto-passed");
			expect(reviewStep.output).not.toContain("not yet implemented");

			// The step should have taken some real time (sub-agent spawning)
			// or failed with a meaningful error (not instant auto-pass)
			expect(reviewStep.duration_ms).toBeGreaterThan(0);
		} finally {
			await deleteGoal(goalId);
		}
	});
});
