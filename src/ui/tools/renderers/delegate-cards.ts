/**
 * Shared delegate card rendering components.
 *
 * Used by both DelegateRenderer (standalone delegate tool) and
 * WorkflowRenderer (run_phase action that spawns sub-agents).
 */

import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { Bot, ScrollText } from "lucide";
import "../../components/LiveTimer.js";

// ── Types ──

export interface DelegateCardEntry {
	id: string;
	/** Display name or instruction summary */
	name: string;
	status: string;
	durationMs: number;
	/** The full session ID (for linking to the delegate session) */
	sessionId?: string;
}



// ── Formatting helpers ──

export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max) + "…";
}

export function summarizeInstructions(instructions: string): string {
	const firstLine = instructions.split("\n")[0].trim();
	return truncate(firstLine, 100);
}

// ── Status rendering ──

export function statusColor(status: string): string {
	if (status === "completed") return "text-green-500";
	if (status === "timeout") return "text-orange-500";
	if (status === "running" || status === "starting") return "text-muted-foreground animate-pulse";
	return "text-red-500";
}

export function statusIcon(status: string): string {
	if (status === "completed") return "✓";
	if (status === "running") return "⏳";
	if (status === "starting") return "⏳";
	if (status === "timeout") return "⏱";
	return "✗";
}

// ── Auth token ──

export function getAuthToken(): string | null {
	try { return localStorage.getItem("gateway.token") || null; } catch { return null; }
}

// ── Render primitives ──

/** Render a session link for a delegate (opens the delegate session in a new tab) */
export function renderSessionLink(sessionId: string | undefined, delegateId?: string): TemplateResult {
	if (!sessionId) {
		// Fallback to old log link if no session ID
		if (!delegateId || delegateId === "?") return html``;
		const token = getAuthToken();
		const logUrl = `/api/delegate-logs/${delegateId}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
		return html`
			<a href="${logUrl}" target="_blank" rel="noopener"
				class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded hover:bg-accent transition-colors"
				title="View delegate agent logs"
			>${icon(ScrollText, "xs")} logs</a>
		`;
	}
	const token = getAuthToken();
	const sessionUrl = `/?token=${token ? encodeURIComponent(token) : ""}#/session/${sessionId}`;
	return html`
		<a href="${sessionUrl}" target="_blank" rel="noopener"
			class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded hover:bg-accent transition-colors"
			title="View delegate session"
		>${icon(ScrollText, "xs")} view</a>
	`;
}



/** Render duration: live timer if running/starting, static text if done */
export function renderDuration(entry: DelegateCardEntry): TemplateResult {
	if (entry.status === "running" || entry.status === "starting") {
		// Compute real start time from durationMs so it survives page refreshes.
		// The heartbeat updates durationMs every 3s with the actual elapsed time.
		const startTime = Date.now() - entry.durationMs;
		return html`<span class="text-xs text-muted-foreground"><live-timer .startTime=${startTime} .running=${true}></live-timer></span>`;
	}
	return html`<span class="text-xs text-muted-foreground">${formatDuration(entry.durationMs)}</span>`;
}

// ── Composite card renderers ──

/** Render a full delegate card (icon, name, duration, session link) */
export function renderDelegateCard(entry: DelegateCardEntry): TemplateResult {
	return html`
		<div class="p-2 border border-border rounded text-sm flex items-center gap-2">
			<span class="${statusColor(entry.status)}">${statusIcon(entry.status)}</span>
			<span class="inline-block text-muted-foreground">${icon(Bot, "sm")}</span>
			<span class="font-mono text-xs flex-1 min-w-0 truncate">${entry.name}</span>
			${renderDuration(entry)}
			${renderSessionLink(entry.sessionId, entry.id)}
		</div>
	`;
}

/** Render a card for a delegate that's still starting (no ID yet) */
export function renderRunningCard(name: string, delegateId?: string): TemplateResult {
	if (delegateId) {
		return renderDelegateCard({ id: delegateId, name, status: "running", durationMs: 0 });
	}
	return html`
		<div class="p-2 border border-border rounded text-sm flex items-center gap-2">
			<span class="text-muted-foreground animate-pulse">⏳</span>
			<span class="inline-block text-muted-foreground">${icon(Bot, "sm")}</span>
			<span class="font-mono text-xs flex-1 min-w-0 truncate">${name}</span>
			<span class="text-xs text-muted-foreground">starting…</span>
		</div>
	`;
}

/** Render compact status pills for a header row (e.g., "✓ Name (12s) ✗ Name (3s)") */
export function renderStatusPills(entries: DelegateCardEntry[]): TemplateResult {
	return html`${entries.map((d) => html`
		<span class="inline-flex items-center gap-0.5 mx-0.5">
			<span class="${statusColor(d.status)}">${statusIcon(d.status)}</span>
			<span class="text-xs">${d.name}</span>
			<span class="text-[10px] text-muted-foreground">(${formatDuration(d.durationMs)})</span>
		</span>
	`)}`;
}

/** Render the full card list with optional failure warning */
export function renderDelegateCardList(entries: DelegateCardEntry[]): TemplateResult {
	const failCount = entries.filter((d) => d.status !== "completed" && d.status !== "running" && d.status !== "starting").length;
	return html`
		<div class="space-y-1">
			${entries.map((d) => renderDelegateCard(d))}
		</div>
		${failCount > 0 ? html`<div class="mt-2 text-sm text-destructive">Warning: ${failCount} delegate(s) failed or timed out.</div>` : ""}
	`;
}
