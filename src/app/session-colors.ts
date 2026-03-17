import { html } from "lit";
import { patchSession } from "./api.js";
import { activeSessionId, renderApp } from "./state.js";

// ============================================================================
// AURORA BOREALIS PALETTE
// ============================================================================

/**
 * 20 curated hue-rotate offsets from canonical green (90°).
 * Flows from greens → teals → blues → purples → pinks and back.
 */
export const BOBBIT_HUE_ROTATIONS = [
	0, 25, 50, 75, 100, 125, 150, 175, 200, 225,
	-135, -110, -85, -60, -35, -10, 15, 40, 65, 250,
];

/** Map of session ID → assigned palette index, loaded from server */
export const sessionColorMap = new Map<string, number>();

function nextAvailableColorIndex(): number {
	const used = new Set(sessionColorMap.values());
	for (let i = 0; i < BOBBIT_HUE_ROTATIONS.length; i++) {
		if (!used.has(i)) return i;
	}
	return sessionColorMap.size % BOBBIT_HUE_ROTATIONS.length;
}

/**
 * Get the hue-rotate offset for a session. Assigns colors from the Aurora
 * Borealis palette, persisted on the server for cross-device coherency.
 */
export function sessionHueRotation(sessionId: string): number {
	let idx = sessionColorMap.get(sessionId);
	if (idx === undefined) {
		idx = nextAvailableColorIndex();
		sessionColorMap.set(sessionId, idx);
		patchSession(sessionId, { colorIndex: idx });
	}
	return BOBBIT_HUE_ROTATIONS[idx];
}

/** Change a session's color to a specific palette index */
export function setSessionColor(sessionId: string, paletteIndex: number): void {
	sessionColorMap.set(sessionId, paletteIndex);
	patchSession(sessionId, { colorIndex: paletteIndex });
	if (activeSessionId() === sessionId) {
		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${BOBBIT_HUE_ROTATIONS[paletteIndex]}deg`);
	}
	renderApp();
}

/**
 * Generate a 3-letter uppercase acronym from a session title.
 * Takes first letters of the first 3 significant words.
 */
export function sessionAcronym(title: string): string {
	const stopWords = new Set(["the", "a", "an", "and", "or", "in", "on", "to", "of", "for", "with", "is", "it"]);
	const words = title.split(/[\s\-_/]+/).filter((w) => w.length > 0 && !stopWords.has(w.toLowerCase()));
	if (words.length >= 3) return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
	if (words.length === 2) return (words[0][0] + words[1][0] + (words[1][1] || "")).toUpperCase();
	if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
	return title.slice(0, 3).toUpperCase();
}

/**
 * Tiny static Bobbit pixel-art icon used as a session status indicator.
 * Same 10×9 pixel grid as the streaming blob, but scaled down and colored
 * per session status. No animation, no blinking — just a little Bobbit.
 */
export function statusBobbit(status: string, isCompacting = false, sessionId?: string, isSelected = false, isAborting = false, isTeamLead = false) {
	const hueRotate = sessionId ? sessionHueRotation(sessionId) : 0;

	const canonical = { main: "#8ec63f", light: "#b5d98a", dark: "#6b9930", eye: "#1a3010" };
	let p: typeof canonical;
	if (status === "starting") {
		p = { main: "#eab308", light: "#fde047", dark: "#ca8a04", eye: "#2d2006" };
	} else if (status === "terminated") {
		p = { main: "#ef4444", light: "#fca5a5", dark: "#dc2626", eye: "#2c0b0e" };
	} else {
		p = canonical;
	}

	const isBusy = status === "streaming" || isCompacting;

	const eyeColor = isSelected ? p.main : p.eye;
	const shadow = `
		3px 0px 0 #000,4px 0px 0 #000,5px 0px 0 #000,6px 0px 0 #000,7px 0px 0 #000,
		2px 1px 0 #000,3px 1px 0 ${p.main},4px 1px 0 ${p.main},5px 1px 0 ${p.main},6px 1px 0 ${p.light},7px 1px 0 ${p.light},8px 1px 0 #000,
		1px 2px 0 #000,2px 2px 0 ${p.main},3px 2px 0 ${p.main},4px 2px 0 ${p.main},5px 2px 0 ${p.main},6px 2px 0 ${p.main},7px 2px 0 ${p.light},8px 2px 0 ${p.main},9px 2px 0 #000,
		0px 3px 0 #000,1px 3px 0 ${p.main},2px 3px 0 ${p.main},3px 3px 0 ${p.main},4px 3px 0 ${p.main},5px 3px 0 ${p.main},6px 3px 0 ${p.main},7px 3px 0 ${p.main},8px 3px 0 ${p.main},9px 3px 0 #000,
		0px 4px 0 #000,1px 4px 0 ${p.main},2px 4px 0 ${p.main},3px 4px 0 ${eyeColor},4px 4px 0 ${p.main},5px 4px 0 ${p.main},6px 4px 0 ${eyeColor},7px 4px 0 ${p.main},8px 4px 0 ${p.main},9px 4px 0 #000,
		0px 5px 0 #000,1px 5px 0 ${p.main},2px 5px 0 ${p.main},3px 5px 0 ${eyeColor},4px 5px 0 ${p.main},5px 5px 0 ${p.main},6px 5px 0 ${eyeColor},7px 5px 0 ${p.main},8px 5px 0 ${p.main},9px 5px 0 #000,
		0px 6px 0 #000,1px 6px 0 ${p.dark},2px 6px 0 ${p.main},3px 6px 0 ${p.main},4px 6px 0 ${p.main},5px 6px 0 ${p.main},6px 6px 0 ${p.main},7px 6px 0 ${p.main},8px 6px 0 ${p.main},9px 6px 0 #000,
		1px 7px 0 #000,2px 7px 0 ${p.dark},3px 7px 0 ${p.main},4px 7px 0 ${p.main},5px 7px 0 ${p.main},6px 7px 0 ${p.main},7px 7px 0 ${p.main},8px 7px 0 #000,
		2px 8px 0 #000,3px 8px 0 #000,4px 8px 0 #000,5px 8px 0 #000,6px 8px 0 #000,7px 8px 0 #000
	`;

	const eyeShadow = `3px 4px 0 ${p.eye},6px 4px 0 ${p.eye},3px 5px 0 ${p.eye},6px 5px 0 ${p.eye}`;

	const shimmerDelay = -(Date.now() % 8000);
	const shimmer = isBusy ? `animation:blob-shimmer 8s ease-in-out infinite;animation-delay:${shimmerDelay}ms;` : "";
	const isIdle = status === "idle" && !isCompacting && !isSelected;
	const isCancelling = isAborting && (status === "streaming" || isBusy);
	const filters: string[] = [];
	if (hueRotate && status !== "starting" && status !== "terminated") filters.push(`hue-rotate(${hueRotate}deg)`);
	if (isCancelling) filters.push("saturate(0.3)");
	else if (isIdle) filters.push("saturate(0.4)");
	const filterStyle = filters.length ? `filter:${filters.join(" ")};` : "";
	const idleAnim = isIdle ? "animation:bobbit-breathe 4s ease-in-out infinite;" : "";
	const bobAnim = isBusy && !isCancelling ? "animation:bobbit-bob 1.8s cubic-bezier(0.34,1.2,0.64,1) infinite;" : "";
	const cancelAnim = isCancelling ? "animation:bobbit-cancel-fade 1.2s ease-in-out infinite;" : "";
	const compactSquish = isCompacting && !isCancelling;
	const baseTransform = isCompacting
		? (compactSquish
			? "transform-origin:0 9px;animation:bobbit-squish 1.5s ease-in-out infinite;"
			: "transform:scale(1.6) scaleX(1.0) scaleY(0.75) translateY(4.5px);transform-origin:0 9px;")
		: "transform:scale(1.6);transform-origin:0 0;";
	const eyeAnim = isSelected
		? `animation:${isCompacting ? "bobbit-eyes-squash" : "bobbit-eyes"} 6s step-end infinite;transform-origin:0 ${isCompacting ? "9px" : "0"};`
		: baseTransform;

	const eyeTop = isTeamLead ? "4px" : "0";
	const eyeLayer = isSelected
		? html`<span style="position:absolute;left:0;top:${eyeTop};display:block;width:1px;height:1px;image-rendering:pixelated;box-shadow:${eyeShadow};${eyeAnim}"></span>`
		: "";

	// Crown overlay for team leads — same pixel grid, not hue-rotated
	const crownShadow = `
		3px -1px 0 #000,5px -1px 0 #000,7px -1px 0 #000,
		2px 0 0 #000,3px 0 0 #fde047,4px 0 0 #000,5px 0 0 #fde047,6px 0 0 #000,7px 0 0 #fde047,8px 0 0 #000,
		1px 1px 0 #000,2px 1px 0 #fbbf24,3px 1px 0 #fde047,4px 1px 0 #fbbf24,5px 1px 0 #fde047,6px 1px 0 #fbbf24,7px 1px 0 #fde047,8px 1px 0 #fbbf24,9px 1px 0 #000,
		1px 2px 0 #000,2px 2px 0 #b45309,3px 2px 0 #d97706,4px 2px 0 #d97706,5px 2px 0 #d97706,6px 2px 0 #d97706,7px 2px 0 #d97706,8px 2px 0 #b45309,9px 2px 0 #000,
		1px 3px 0 #000,2px 3px 0 #000,3px 3px 0 #000,4px 3px 0 #000,5px 3px 0 #000,6px 3px 0 #000,7px 3px 0 #000,8px 3px 0 #000,9px 3px 0 #000
	`;
	// Counter-rotate crown so it keeps fixed gold colour regardless of identity hue
	const crownFilter = hueRotate && status !== "starting" && status !== "terminated"
		? `filter:hue-rotate(${-hueRotate}deg);`
		: "";
	const crownLayer = isTeamLead
		? html`<span style="position:absolute;left:0;top:${isTeamLead ? "2px" : "0"};display:block;width:1px;height:1px;image-rendering:pixelated;box-shadow:${crownShadow};${baseTransform}${crownFilter}"></span>`
		: "";

	// Shift inner content down 2px when hatted so crown tips aren't clipped
	const innerTop = isTeamLead ? "4px" : "0";
	const containerHeight = isTeamLead ? "19px" : "15px";

	return html`<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:${containerHeight};flex-shrink:0;position:relative;overflow:hidden;margin-top:2px;${filterStyle}${bobAnim}${cancelAnim}${idleAnim}"><span style="position:absolute;left:0;top:${innerTop};display:block;width:1px;height:1px;image-rendering:pixelated;${baseTransform}box-shadow:${shadow};${shimmer}"></span>${eyeLayer}${crownLayer}</span>`;
}
