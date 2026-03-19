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
			const prevGoalIds = new Set(state.goals.map((g) => g.id));
			state.goals = goalsData.goals || [];
			// Auto-expand only newly discovered goals that have sessions — never
			// re-expand a goal the user has already seen (and may have collapsed).
			for (const g of state.goals) {
				if (!prevGoalIds.has(g.id) && state.gatewaySessions.some((s) => s.goalId === g.id)) {
					expandedGoals.add(g.id);
					saveExpandedGoals();
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
// GIT STATUS
// ============================================================================

export interface GitStatusData {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	summary: string;
	clean: boolean;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
	unpushed: boolean;
	status: Array<{ file: string; status: string }>;
}

export async function fetchGitStatus(sessionId: string): Promise<GitStatusData | null> {
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/git-status`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// ============================================================================
// GOAL API
// ============================================================================

export async function createGoal(title: string, cwd: string, opts?: { spec?: string; team?: boolean; worktree?: boolean }): Promise<Goal | null> {
	const { spec = "", team = false, worktree = false } = opts ?? {};
	try {
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title, cwd, spec, team, worktree }),
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

export async function updateGoal(id: string, updates: Partial<Pick<Goal, "title" | "cwd" | "state" | "spec" | "team">>): Promise<boolean> {
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

// ============================================================================
// TEAM API
// ============================================================================

/** @deprecated Use createGoal with { team: true, worktree } instead */
export async function createTeamGoal(title: string, cwd: string, spec = "", worktree = true): Promise<Goal | null> {
	return createGoal(title, cwd, { spec, team: true, worktree });
}

export async function startTeam(goalId: string): Promise<string | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/start`, {
			method: "POST",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		const data = await res.json();
		await refreshSessions();
		return data.sessionId;
	} catch (err) {
		showConnectionError("Failed to start team", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function getTeamState(goalId: string): Promise<any | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function completeTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/complete`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to complete team", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function teardownTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/teardown`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to tear down team", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ============================================================================
// GOAL ARTIFACT API
// ============================================================================

export type ArtifactType = "design-doc" | "test-plan" | "review-findings" | "gap-analysis" | "security-findings" | "custom";

export interface GoalArtifact {
	id: string;
	goalId: string;
	name: string;
	type: ArtifactType;
	content: string;
	producedBy: string;
	skillId?: string;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export async function fetchGoalArtifacts(goalId: string): Promise<GoalArtifact[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/artifacts`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.artifacts || [];
	} catch {
		return [];
	}
}

export async function fetchGoalArtifact(goalId: string, artifactId: string): Promise<GoalArtifact | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/artifacts/${artifactId}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// ============================================================================
// ROLE API
// ============================================================================

export interface RoleData {
	name: string;
	label: string;
	promptTemplate: string;
	allowedTools: string[];
	accessory: string;
	createdAt: number;
	updatedAt: number;
}

export async function fetchRoles(): Promise<RoleData[]> {
	try {
		const res = await gatewayFetch("/api/roles");
		if (!res.ok) throw new Error(`Failed to fetch roles: ${res.status}`);
		const data = await res.json();
		const roles: RoleData[] = data.roles || data || [];
		// Also cache into state for the role picker sidebar
		state.roles = roles.map((r) => ({
			name: r.name,
			label: r.label,
			accessory: r.accessory,
		}));
		return roles;
	} catch (err) {
		console.error("[role-api] fetchRoles failed:", err);
		return [];
	}
}

export async function fetchTools(): Promise<string[]> {
	try {
		const res = await gatewayFetch("/api/tools");
		if (!res.ok) throw new Error(`Failed to fetch tools: ${res.status}`);
		const data = await res.json();
		return data.tools || data || [];
	} catch (err) {
		console.error("[role-api] fetchTools failed:", err);
		return [];
	}
}

export async function createRole(role: {
	name: string;
	label: string;
	promptTemplate: string;
	allowedTools: string[];
	accessory: string;
}): Promise<RoleData | null> {
	try {
		const res = await gatewayFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify(role),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to create role", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateRole(name: string, updates: Partial<Pick<RoleData, "label" | "promptTemplate" | "allowedTools" | "accessory">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/roles/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to update role", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteRole(name: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/roles/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to delete role", err instanceof Error ? err.message : String(err));
		return false;
	}
}
