import {
	state,
	renderApp,
	expandedGoals,
	saveExpandedGoals,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	type GatewaySession,
	type Goal,
} from "./state.js";
import { sessionHueRotation, sessionColorMap } from "./session-colors.js";

// dialogs.ts imports from api.ts, so we use dynamic import to break the cycle
async function showConnectionError(title: string, message: string): Promise<void> {
	const { showConnectionError: show } = await import("./dialogs.js");
	show(title, message);
}

// ============================================================================
// GATEWAY FETCH
// ============================================================================

export function gatewayFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const url = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	return fetch(`${url}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

export function updateLocalSessionTitle(sessionId: string, title: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], title };
		renderApp();
	}
}

export function updateLocalSessionStatus(sessionId: string, status: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], status, lastActivity: Date.now() };
		renderApp();
	}
}

export function startSessionPolling(): void {
	stopSessionPolling();
	state.sessionPollTimer = setInterval(() => {
		if (state.appView === "authenticated" && document.visibilityState === "visible") {
			refreshSessions();
		}
	}, 5_000);
}

export function stopSessionPolling(): void {
	if (state.sessionPollTimer) {
		clearInterval(state.sessionPollTimer);
		state.sessionPollTimer = null;
	}
}

export async function refreshSessions(): Promise<void> {
	const isInitial = state.gatewaySessions.length === 0 && !state.sessionsError;
	if (isInitial) {
		state.sessionsLoading = true;
		state.sessionsError = "";
		renderApp();
	}

	try {
		const [sessionsRes, goalsRes] = await Promise.all([
			gatewayFetch("/api/sessions"),
			gatewayFetch("/api/goals"),
		]);
		if (!sessionsRes.ok) throw new Error(`Failed to fetch sessions: ${sessionsRes.status}`);
		const sessionsData = await sessionsRes.json();
		state.gatewaySessions = sessionsData.sessions || [];

		for (const s of state.gatewaySessions) {
			if (s.colorIndex !== undefined && !sessionColorMap.has(s.id)) {
				sessionColorMap.set(s.id, s.colorIndex);
			}
			sessionHueRotation(s.id);
		}

		if (goalsRes.ok) {
			const goalsData = await goalsRes.json();
			state.goals = goalsData.goals || [];
			for (const g of state.goals) {
				if (state.gatewaySessions.some((s) => s.goalId === g.id)) {
					expandedGoals.add(g.id);
				}
			}
		}

		state.sessionsError = "";
	} catch (err) {
		if (isInitial) {
			state.sessionsError = err instanceof Error ? err.message : String(err);
			state.gatewaySessions = [];
		}
	} finally {
		state.sessionsLoading = false;
		renderApp();
	}
}

// ============================================================================
// GOAL API
// ============================================================================

export async function createGoal(title: string, cwd: string, spec = ""): Promise<Goal | null> {
	try {
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title, cwd, spec }),
		});
		if (!res.ok) throw new Error(`Failed to create goal: ${res.status}`);
		const goal = await res.json();
		await refreshSessions();
		expandedGoals.add(goal.id);
		saveExpandedGoals();
		return goal;
	} catch (err) {
		showConnectionError("Failed to create goal", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateGoal(id: string, updates: Partial<Pick<Goal, "title" | "cwd" | "state" | "spec">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw new Error(`Failed to update goal: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to update goal", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteGoal(id: string): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const goal = state.goals.find((g) => g.id === id);
	const goalTitle = goal?.title || "this goal";
	const sessionsUnderGoal = state.gatewaySessions.filter((s) => s.goalId === id);

	let message = `Are you sure you want to delete "${goalTitle}"?`;
	if (sessionsUnderGoal.length > 0) {
		message += ` Its ${sessionsUnderGoal.length} session(s) will become ungrouped.`;
	}

	const confirmed = await confirmAction("Delete Goal", message, "Delete", true);
	if (!confirmed) return;

	try {
		await gatewayFetch(`/api/goals/${id}`, { method: "DELETE" });
		expandedGoals.delete(id);
		saveExpandedGoals();
		await refreshSessions();
	} catch (err) {
		showConnectionError("Failed to delete goal", err instanceof Error ? err.message : String(err));
	}
}

/** Persist a session property update to the server via PATCH */
export function patchSession(sessionId: string, updates: Record<string, unknown>): void {
	gatewayFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	}).catch(() => { /* best-effort */ });
}
