// src/app/proposals-page.ts
import { icon } from "@mariozechner/mini-lit";
import { html, TemplateResult } from "lit";
import { ArrowLeft, ChevronDown, ChevronRight, Lightbulb, Check, X } from "lucide";
import { renderApp } from "./state.js";
import { gatewayFetch } from "./api.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// TYPES
// ============================================================================

interface Proposal {
	id: string;
	targetType: "role_prompt" | "agents_md" | "system_prompt" | "workflow";
	targetName: string;
	reasoning: string;
	evidence: string;
	proposedDiff: string;
	status: "pending" | "approved" | "rejected";
	createdAt: string;
	reviewedAt: string | null;
}

// ============================================================================
// MODULE STATE
// ============================================================================

let proposals: Proposal[] = [];
let loading = true;
let error = "";
let expandedProposalId: string | null = null;
let historyExpanded = false;
let actionInProgress: string | null = null;
let actionResult: { id: string; status: string; message: string } | null = null;

// ============================================================================
// DATA LOADING
// ============================================================================

export function clearProposalsPageState(): void {
	proposals = [];
	loading = true;
	error = "";
	expandedProposalId = null;
	historyExpanded = false;
	actionInProgress = null;
	actionResult = null;
}

export async function loadProposalsPageData(): Promise<void> {
	loading = true;
	error = "";
	renderApp();

	try {
		const res = await gatewayFetch("/api/proposals");
		if (!res.ok) throw new Error(`Failed to fetch proposals: ${res.status}`);
		const data = await res.json();
		proposals = ((data.proposals || []) as any[]).map(mapProposal);
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : String(err);
	} finally {
		loading = false;
		renderApp();
	}
}

/** Map snake_case server response to camelCase client interface. */
function mapProposal(p: any): Proposal {
	return {
		id: p.id,
		targetType: p.target_type ?? p.targetType,
		targetName: p.target_name ?? p.targetName,
		reasoning: p.reasoning ?? "",
		evidence: p.evidence ?? "",
		proposedDiff: p.proposed_diff ?? p.proposedDiff ?? "",
		status: p.status,
		createdAt: p.created_at ?? p.createdAt ?? "",
		reviewedAt: p.reviewed_at ?? p.reviewedAt ?? null,
	};
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleApprove(id: string, targetName: string): Promise<void> {
	actionInProgress = id;
	actionResult = null;
	renderApp();

	try {
		const res = await gatewayFetch(`/api/proposals/${id}`, {
			method: "PUT",
			body: JSON.stringify({ status: "approved" }),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		actionResult = { id, status: "approved", message: `Applied to ${targetName}. Written to Claude Code memory.` };
		renderApp();
		// Reload after a brief pause so user sees the message
		setTimeout(() => loadProposalsPageData(), 1500);
	} catch (err: unknown) {
		actionResult = { id, status: "error", message: err instanceof Error ? err.message : String(err) };
		renderApp();
	} finally {
		actionInProgress = null;
	}
}

async function handleReject(id: string): Promise<void> {
	actionInProgress = id;
	actionResult = null;
	renderApp();

	try {
		const res = await gatewayFetch(`/api/proposals/${id}`, {
			method: "PUT",
			body: JSON.stringify({ status: "rejected" }),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		actionResult = { id, status: "rejected", message: "Proposal rejected." };
		renderApp();
		setTimeout(() => loadProposalsPageData(), 1500);
	} catch (err: unknown) {
		actionResult = { id, status: "error", message: err instanceof Error ? err.message : String(err) };
		renderApp();
	} finally {
		actionInProgress = null;
	}
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTimestamp(iso: string): string {
	if (!iso) return "";
	try {
		const date = new Date(iso);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60_000);
		if (diffMins < 1) return "just now";
		if (diffMins < 60) return `${diffMins}m ago`;
		const diffHours = Math.floor(diffMins / 60);
		if (diffHours < 24) return `${diffHours}h ago`;
		const diffDays = Math.floor(diffHours / 24);
		if (diffDays < 30) return `${diffDays}d ago`;
		return date.toLocaleDateString();
	} catch {
		return iso;
	}
}

function targetBadge(targetType: string): TemplateResult {
	const badges: Record<string, { label: string; classes: string }> = {
		role_prompt: { label: "Role Prompt", classes: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30" },
		agents_md: { label: "AGENTS.md", classes: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" },
		system_prompt: { label: "System Prompt", classes: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30" },
		workflow: { label: "Workflow", classes: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30" },
	};
	const badge = badges[targetType] || { label: targetType, classes: "bg-muted text-muted-foreground border-border" };
	return html`<span class="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${badge.classes}">${badge.label}</span>`;
}

function statusBadge(status: string): TemplateResult {
	if (status === "approved") {
		return html`<span class="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30">${icon(Check, "xs")} Approved</span>`;
	}
	if (status === "rejected") {
		return html`<span class="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">${icon(X, "xs")} Rejected</span>`;
	}
	return html`<span class="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">Pending</span>`;
}

// ============================================================================
// CARD RENDERING
// ============================================================================

function renderProposalCard(proposal: Proposal): TemplateResult {
	const isPending = proposal.status === "pending";
	const isExpanded = expandedProposalId === proposal.id;
	const isActioning = actionInProgress === proposal.id;
	const result = actionResult?.id === proposal.id ? actionResult : null;

	return html`
		<div class="border border-border rounded-lg p-4 ${isPending ? '' : 'opacity-75'}">
			<!-- Header -->
			<div class="flex items-start gap-2 mb-2 flex-wrap">
				${targetBadge(proposal.targetType)}
				<span class="text-sm font-medium text-foreground">${proposal.targetName}</span>
				${!isPending ? statusBadge(proposal.status) : ""}
				<span class="ml-auto text-xs text-muted-foreground">${formatTimestamp(proposal.createdAt)}</span>
			</div>

			<!-- Reasoning -->
			${proposal.reasoning ? html`
				<div class="mb-2">
					<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-1">Reasoning</div>
					<div class="text-sm text-foreground/90 prose-sm"><markdown-block .text=${proposal.reasoning}></markdown-block></div>
				</div>
			` : ""}

			<!-- Evidence -->
			${proposal.evidence ? html`
				<div class="mb-2">
					<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-1">Evidence</div>
					<div class="text-sm text-foreground/70 prose-sm"><markdown-block .text=${proposal.evidence}></markdown-block></div>
				</div>
			` : ""}

			<!-- Diff toggle -->
			${proposal.proposedDiff ? html`
				<button
					class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors mb-2"
					@click=${() => { expandedProposalId = isExpanded ? null : proposal.id; renderApp(); }}
				>
					${icon(isExpanded ? ChevronDown : ChevronRight, "xs")}
					${isExpanded ? "Hide" : "Show"} proposed changes
				</button>
				${isExpanded ? html`
					<div class="mb-3 rounded-md border border-border overflow-hidden">
						${proposal.targetType === "agents_md"
							? html`<div class="p-3 bg-muted/30 text-sm prose-sm"><markdown-block .text=${proposal.proposedDiff}></markdown-block></div>`
							: html`<pre class="p-3 bg-muted/30 text-xs overflow-x-auto whitespace-pre-wrap font-mono">${proposal.proposedDiff}</pre>`}
					</div>
				` : ""}
			` : ""}

			<!-- Actions -->
			${isPending ? html`
				<div class="flex items-center gap-2 mt-2">
					<button
						class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
							${isActioning ? "opacity-50 pointer-events-none" : ""}
							bg-green-600 text-white hover:bg-green-700"
						@click=${() => handleApprove(proposal.id, proposal.targetName)}
						?disabled=${isActioning}
					>
						${icon(Check, "xs")} Approve
					</button>
					<button
						class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
							${isActioning ? "opacity-50 pointer-events-none" : ""}
							bg-red-600/10 text-red-600 dark:text-red-400 hover:bg-red-600/20 border border-red-600/30"
						@click=${() => handleReject(proposal.id)}
						?disabled=${isActioning}
					>
						${icon(X, "xs")} Reject
					</button>
					${result ? html`<span class="text-xs ${result.status === "error" ? "text-red-500" : result.status === "approved" ? "text-green-500" : "text-muted-foreground"}">${result.message}</span>` : ""}
				</div>
			` : html`
				${result ? html`<div class="text-xs mt-1 ${result.status === "error" ? "text-red-500" : "text-muted-foreground"}">${result.message}</div>` : ""}
				${proposal.reviewedAt ? html`<div class="text-xs text-muted-foreground mt-1">Reviewed ${formatTimestamp(proposal.reviewedAt)}</div>` : ""}
			`}
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderProposalsPage(): TemplateResult {
	const pending = proposals.filter((p) => p.status === "pending");
	const history = proposals.filter((p) => p.status !== "pending");

	return html`
		<div class="flex-1 overflow-y-auto">
			<!-- Nav bar -->
			<div class="flex items-center gap-2 px-4 py-3 border-b border-border">
				<button
					class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
					@click=${() => setHashRoute("landing")}
					title="Back"
				>
					${icon(ArrowLeft, "sm")}
				</button>
				<span class="text-muted-foreground">${icon(Lightbulb, "sm")}</span>
				<h1 class="text-base font-semibold text-foreground">Proposals</h1>
				${pending.length > 0 ? html`<span class="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[11px] font-bold rounded-full bg-primary text-primary-foreground">${pending.length}</span>` : ""}
			</div>

			<div class="max-w-3xl mx-auto px-4 py-6">
				${loading ? html`<div class="text-center py-12 text-muted-foreground text-sm">Loading proposals…</div>` : ""}
				${error ? html`
					<div class="text-center py-12">
						<p class="text-sm text-red-500 mb-2">${error}</p>
						<button class="text-sm text-primary hover:underline" @click=${() => loadProposalsPageData()}>Retry</button>
					</div>
				` : ""}
				${!loading && !error && proposals.length === 0 ? html`
					<div class="text-center py-12">
						<div class="text-muted-foreground mb-2">${icon(Lightbulb, "lg")}</div>
						<p class="text-sm text-muted-foreground mb-1">No proposals yet.</p>
						<p class="text-xs text-muted-foreground">The observer will analyze task outcomes and suggest improvements after enough data is collected.</p>
						<p class="text-xs text-muted-foreground mt-2">Trigger manually via the API: <code class="px-1 py-0.5 bg-muted rounded text-[11px]">POST /api/observer/run</code></p>
					</div>
				` : ""}

				<!-- Pending proposals -->
				${!loading && !error && pending.length > 0 ? html`
					<div class="mb-6">
						<h2 class="text-sm font-semibold text-foreground mb-3">Pending Review (${pending.length})</h2>
						<div class="flex flex-col gap-3">
							${pending.map(renderProposalCard)}
						</div>
					</div>
				` : ""}

				<!-- History -->
				${!loading && !error && history.length > 0 ? html`
					<div>
						<button
							class="flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors mb-3"
							@click=${() => { historyExpanded = !historyExpanded; renderApp(); }}
						>
							${icon(historyExpanded ? ChevronDown : ChevronRight, "xs")}
							History (${history.length})
						</button>
						${historyExpanded ? html`
							<div class="flex flex-col gap-3">
								${history.map(renderProposalCard)}
							</div>
						` : ""}
					</div>
				` : ""}
			</div>
		</div>
	`;
}
