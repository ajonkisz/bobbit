import { icon } from "@mariozechner/mini-lit";
import { html, svg } from "lit";
import { Pencil, Trash2 } from "lucide";
import { state, activeSessionId, type GatewaySession, type GoalState } from "./state.js";
import { statusBobbit } from "./session-colors.js";
import { connectToSession, terminateSession } from "./session-manager.js";
import { showRenameDialog } from "./dialogs.js";

// ============================================================================
// TOOLTIP
// ============================================================================

let _tooltipEl: HTMLDivElement | null = null;
let _tooltipTimer: ReturnType<typeof setTimeout> | null = null;

function getTooltipEl(): HTMLDivElement {
	if (!_tooltipEl) {
		_tooltipEl = document.createElement("div");
		_tooltipEl.className = "sidebar-tooltip";
		document.body.appendChild(_tooltipEl);
	}
	return _tooltipEl;
}

export function showSessionTooltip(e: MouseEvent, session: GatewaySession, displayTitle: string): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	const el = getTooltipEl();
	el.innerHTML = `
		<div class="tt-title">${escapeHtml(displayTitle)}</div>
		<div class="tt-cwd">${escapeHtml(session.cwd)}</div>
		<div class="tt-meta">${escapeHtml(formatSessionAge(session.lastActivity))}</div>
	`;
	const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
	el.style.left = `${rect.right + 8}px`;
	el.style.top = `${rect.top + rect.height / 2}px`;
	el.style.transform = "translateY(-50%)";
	el.classList.add("visible");
}

export function hideSessionTooltip(): void {
	if (_tooltipTimer) clearTimeout(_tooltipTimer);
	_tooltipTimer = setTimeout(() => {
		getTooltipEl().classList.remove("visible");
	}, 80);
}

// ============================================================================
// FORMATTING
// ============================================================================

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function shortenPath(fullPath: string): string {
	const parts = fullPath.split(/[/\\]/).filter(Boolean);
	if (parts.length <= 3) return parts.join("/");
	return "…/" + parts.slice(-3).join("/");
}

export function formatSessionAge(timestamp: number): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "";
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// ============================================================================
// SESSION ROW & CARD RENDERERS
// ============================================================================

export const SESSION_ROW_PY = "py-0.5";

/** Compact session row for sidebar */
export function renderSidebarSession(session: GatewaySession) {
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
	return html`
		<div
			class="group relative flex items-center gap-1 pl-3 pr-1 ${SESSION_ROW_PY} rounded-md cursor-pointer transition-colors text-sm
				${active ? "bg-secondary text-foreground sidebar-session-active" : connecting ? "bg-secondary/30 text-muted-foreground" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
			@mouseenter=${(e: MouseEvent) => showSessionTooltip(e, session, displayTitle)}
			@mouseleave=${hideSessionTooltip}
			@click=${() => {
				if (!active && !connecting) connectToSession(session.id, true);
			}}
		>
			<div class="shrink-0 flex items-center justify-center">
				${connecting
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: statusBobbit(session.status, session.isCompacting, session.id, active)}
			</div>
			<div class="flex-1 min-w-0 truncate text-xs ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"}">
				${displayTitle}
			</div>
			<div class="sidebar-actions absolute right-0 top-0 bottom-0 hidden group-hover:flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
				<button
					class="p-0.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground"
					@click=${(e: Event) => {
						e.stopPropagation();
						showRenameDialog(session.id, displayTitle);
					}}
					title="Rename"
				>
					${icon(Pencil, "xs")}
				</button>
				<button
					class="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
					@click=${(e: Event) => {
						e.stopPropagation();
						terminateSession(session.id);
					}}
					title="Terminate"
				>
					${icon(Trash2, "xs")}
				</button>
			</div>
		</div>
	`;
}

/** Full-size session card for mobile landing page */
export function renderSessionCard(session: GatewaySession, index = 0) {
	const active = activeSessionId() === session.id;
	const connecting = state.connectingSessionId === session.id;
	return html`
		<div
			class="group session-card-enter flex items-center gap-4 p-4 rounded-lg border ${connecting ? "border-primary/40 bg-secondary/30" : "border-border hover:border-foreground/20 hover:bg-secondary/50"} cursor-pointer transition-all"
			style="animation-delay: ${index * 50}ms"
			@click=${() => { if (!connecting) connectToSession(session.id, true); }}
		>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-1">
					${connecting
						? html`<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
						: statusBobbit(session.status, session.isCompacting, session.id, active)}
					<span class="text-sm ${session.status === "streaming" || session.status === "busy" || session.isCompacting ? "font-semibold" : "font-normal"} text-foreground">${session.title}</span>
					<span class="text-xs text-muted-foreground">·</span>
					<span class="text-xs text-muted-foreground">${formatSessionAge(session.lastActivity)}</span>
				</div>
				<div class="text-xs text-muted-foreground font-mono truncate" title=${session.cwd}>${session.cwd}</div>
				<div class="mt-1.5 text-xs text-muted-foreground">
					<span class="font-mono text-[10px] opacity-60" title=${session.id}>${session.id.slice(0, 8)}…</span>
				</div>
			</div>
			<div class="flex flex-col gap-1 shrink-0">
				<button
					class="p-2 rounded-md hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-all"
					@click=${(e: Event) => {
						e.stopPropagation();
						showRenameDialog(session.id, session.title);
					}}
					title="Rename session"
				>
					${icon(Pencil, "sm")}
				</button>
				<button
					class="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
					@click=${(e: Event) => {
						e.stopPropagation();
						terminateSession(session.id);
					}}
					title="Terminate session"
				>
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

// ============================================================================
// GOAL STATE ICON
// ============================================================================

export function goalStateIcon(goalState: GoalState, size = 14) {
	const C = 2 * Math.PI * 10;
	const blue = "#3b82f6";
	const green = "#22c55e";
	const grey = "#6b7280";

	let circleContent: ReturnType<typeof svg>;
	if (goalState === "complete") {
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${green}" stroke-width="2"/>`;
	} else if (goalState === "in-progress") {
		const progress = (240 / 360) * C;
		circleContent = svg`
			<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="0.4"/>
			<circle cx="12" cy="12" r="10" fill="none" stroke="${blue}" stroke-width="2"
				stroke-dasharray="${progress} ${C}"
				stroke-dashoffset="0"
				transform="rotate(-90 12 12)"/>
		`;
	} else {
		const opacity = goalState === "shelved" ? "0.3" : "0.5";
		circleContent = svg`<circle cx="12" cy="12" r="10" fill="none" stroke="${grey}" stroke-width="2" opacity="${opacity}"/>`;
	}

	const lineColor = goalState === "complete" ? green : goalState === "in-progress" ? blue : grey;
	const lineOpacity = goalState === "shelved" ? "0.3" : goalState === "todo" ? "0.5" : "1";

	return html`
		<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="display:block;flex-shrink:0;">
			${circleContent}
			${svg`<line x1="22" x2="18" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="6" x2="2" y1="12" y2="12" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="6" y2="2" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
			${svg`<line x1="12" x2="12" y1="22" y2="18" stroke="${lineColor}" stroke-width="2" stroke-linecap="round" opacity="${lineOpacity}"/>`}
		</svg>
	`;
}
