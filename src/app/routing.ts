// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected, #/goal/{id} = dashboard)
// ============================================================================

export type RouteView = "landing" | "session" | "goal" | "goal-dashboard" | "roles";

export function getRouteFromHash(): { view: RouteView; sessionId?: string; goalId?: string } {
	const hash = window.location.hash || "";
	const sessionMatch = hash.match(/^#\/session\/([a-f0-9-]+)$/i);
	if (sessionMatch) {
		return { view: "session", sessionId: sessionMatch[1] };
	}
	const goalMatch = hash.match(/^#\/goal\/([a-f0-9-]+)$/i);
	if (goalMatch) {
		return { view: "goal-dashboard", goalId: goalMatch[1] };
	}
	if (hash === "#/roles") {
		return { view: "roles" };
	}
	return { view: "landing" };
}

export function setHashRoute(view: RouteView, id?: string, replace?: boolean): void {
	let newHash: string;
	if (view === "session" && id) {
		newHash = `#/session/${id}`;
	} else if (view === "goal-dashboard" && id) {
		newHash = `#/goal/${id}`;
	} else if (view === "roles") {
		newHash = "#/roles";
	} else {
		newHash = "#/";
	}
	if (window.location.hash !== newHash) {
		if (replace) {
			history.replaceState({}, "", newHash);
			// Manually dispatch hashchange since replaceState doesn't trigger it
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		} else {
			window.location.hash = newHash;
		}
	}
}

// ============================================================================
// PER-SESSION MODEL PERSISTENCE
// ============================================================================

export function saveSessionModel(sessionId: string, provider: string, modelId: string): void {
	localStorage.setItem(`session.${sessionId}.model`, JSON.stringify({ provider, modelId }));
}

export function loadSessionModel(sessionId: string): { provider: string; modelId: string } | null {
	const raw = localStorage.getItem(`session.${sessionId}.model`);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.provider && parsed.modelId) return parsed;
	} catch {}
	return null;
}

export function clearSessionModel(sessionId: string): void {
	localStorage.removeItem(`session.${sessionId}.model`);
}

// ============================================================================
// DRAFT PERSISTENCE
// ============================================================================

const DRAFT_PREFIX = "bobbit-draft-";
let _draftTimer: ReturnType<typeof setTimeout> | null = null;

export function saveDraft(sessionId: string, text: string): void {
	if (_draftTimer) clearTimeout(_draftTimer);
	_draftTimer = setTimeout(() => {
		if (text.trim()) {
			localStorage.setItem(DRAFT_PREFIX + sessionId, text);
		} else {
			localStorage.removeItem(DRAFT_PREFIX + sessionId);
		}
	}, 100);
}

export function loadDraft(sessionId: string): string {
	return localStorage.getItem(DRAFT_PREFIX + sessionId) || "";
}

export function clearDraft(sessionId: string): void {
	if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
	localStorage.removeItem(DRAFT_PREFIX + sessionId);
}
