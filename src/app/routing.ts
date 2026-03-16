// ============================================================================
// URL ROUTING (hash-based: #/ = landing, #/session/{id} = connected)
// ============================================================================

export function getRouteFromHash(): { view: "landing" | "session"; sessionId?: string } {
	const hash = window.location.hash || "";
	const sessionMatch = hash.match(/^#\/session\/([a-f0-9-]+)$/i);
	if (sessionMatch) {
		return { view: "session", sessionId: sessionMatch[1] };
	}
	return { view: "landing" };
}

export function setHashRoute(view: "landing" | "session", sessionId?: string): void {
	const newHash = view === "session" && sessionId ? `#/session/${sessionId}` : "#/";
	if (window.location.hash !== newHash) {
		window.location.hash = newHash;
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
