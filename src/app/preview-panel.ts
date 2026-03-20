import { gatewayFetch } from "./api.js";
import { state, renderApp, activeSessionId } from "./state.js";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastMtime = 0;
let pollSessionId: string | undefined;

/** Start polling preview HTML for changes (scoped to the active session). */
export function startPreviewPolling(): void {
	const sid = activeSessionId();
	// If session changed, restart polling with new session ID
	if (pollTimer && pollSessionId !== sid) {
		stopPreviewPolling();
	}
	if (pollTimer) return;
	lastMtime = 0;
	pollSessionId = sid;
	pollNow();
	pollTimer = setInterval(pollNow, 1000);
}

/** Stop polling. */
export function stopPreviewPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	lastMtime = 0;
	pollSessionId = undefined;
}

async function pollNow(): Promise<void> {
	if (!state.isPreviewSession) {
		stopPreviewPolling();
		return;
	}
	try {
		const sid = pollSessionId;
		const qs = sid ? `?sessionId=${encodeURIComponent(sid)}` : "";
		const res = await gatewayFetch(`/api/preview${qs}`);
		if (!res.ok) return;
		const data = await res.json();
		if (data.mtime && data.mtime !== lastMtime && data.html) {
			lastMtime = data.mtime;
			state.previewPanelHtml = data.html;
			renderApp();
		}
	} catch {
		// ignore fetch errors
	}
}
