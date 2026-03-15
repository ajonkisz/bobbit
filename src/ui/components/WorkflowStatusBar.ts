import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Minimal workflow state extracted from tool call results */
export interface WorkflowPhaseStatus {
	id: string;
	name: string;
	status: "pending" | "active" | "completed" | "failed" | "reset";
}

export interface WorkflowStatus {
	workflowId: string;
	workflowName: string;
	phases: WorkflowPhaseStatus[];
	overallStatus: "running" | "completed" | "failed" | "cancelled";
	reportUrl?: string;
}

/**
 * Extract workflow status from the message stream by parsing workflow tool results.
 *
 * Scans all messages for workflow tool calls and their results to reconstruct
 * the current state of the workflow.
 */
export function extractWorkflowStatus(messages: any[]): WorkflowStatus | null {
	let status: WorkflowStatus | null = null;
	const workflowToolCallIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type !== "toolCall" || block.name !== "workflow") continue;
				if (block.id) workflowToolCallIds.add(block.id);
				const args = block.arguments;
				if (!args?.action) continue;

				const action = args.action;

				if (action === "start" && args.workflow_id) {
					status = {
						workflowId: args.workflow_id,
						workflowName: args.workflow_id.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
						phases: [],
						overallStatus: "running",
					};
				}
			}
		}

		// Parse tool results — only for workflow tool calls
		if (msg.role === "toolResult" && !msg.isError && msg.toolCallId && workflowToolCallIds.has(msg.toolCallId)) {
			const text = msg.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

			if (!status) continue;

			// Detect workflow start result — extract phase list and name
			if (text.includes("started.") && text.includes("Current Phase:")) {
				const nameMatch = text.match(/Workflow "(.+?)" started/);
				if (nameMatch) status.workflowName = nameMatch[1];

				// Try to get all phase names from "Phases: A → B → C" line
				const phasesLineMatch = text.match(/Phases:\s*(.+)/);
				if (phasesLineMatch && status.phases.length === 0) {
					const names = phasesLineMatch[1].split("→").map((s: string) => s.trim()).filter(Boolean);
					status.phases = names.map((name: string, i: number) => ({
						id: `phase-${i}`,
						name,
						status: i === 0 ? "active" as const : "pending" as const,
					}));
				} else if (status.phases.length === 0) {
					// Fallback: only know current phase and total count
					const phaseInfo = parseCurrentPhase(text);
					if (phaseInfo) {
						status.phases = buildInitialPhases(phaseInfo.name, phaseInfo.total);
					}
				}
			}

			// Detect advance result — "Completed: X | Next: Y (n/total)"
			const advanceMatch = text.match(/Completed:\s*(.+?)\s*\|\s*Next:\s*(.+?)\s*\((\d+)\/(\d+)\)/);
			if (advanceMatch) {
				const completedName = advanceMatch[1];
				const nextName = advanceMatch[2];
				const nextIndex = parseInt(advanceMatch[3]) - 1; // 0-based
				const total = parseInt(advanceMatch[4]);

				// Ensure we have enough phases
				ensurePhaseCount(status, total);

				// Mark completed phase
				const completedPhase = status.phases.find((p) => p.name === completedName);
				if (completedPhase) completedPhase.status = "completed";

				// Mark all phases before nextIndex as completed (in case we missed some)
				for (let i = 0; i < nextIndex; i++) {
					if (status.phases[i] && status.phases[i].status !== "completed") {
						status.phases[i].status = "completed";
					}
				}

				// Update next phase
				if (status.phases[nextIndex]) {
					status.phases[nextIndex].name = nextName;
					status.phases[nextIndex].status = "active";
				}
			}

			// Detect "All phases complete"
			if (text.includes("All phases complete") || text.includes("completed!")) {
				status.overallStatus = "completed";
				for (const p of status.phases) {
					if (p.status === "active" || p.status === "pending") {
						p.status = "completed";
					}
				}
				const reportMatch = text.match(/(\/api\/sessions\/[^/\s]+\/workflow\/report)/);
				if (reportMatch) status.reportUrl = reportMatch[1];
			}

			// Detect fail
			if (text.includes("marked as failed")) {
				status.overallStatus = "failed";
				const activePhase = status.phases.find((p) => p.status === "active");
				if (activePhase) activePhase.status = "failed";
				const reportMatch = text.match(/(\/api\/sessions\/[^/\s]+\/workflow\/report)/);
				if (reportMatch) status.reportUrl = reportMatch[1];
			}

			// Detect cancel
			if (text.includes("cancelled")) {
				status.overallStatus = "cancelled";
			}
		}
	}

	return status;
}

function parseCurrentPhase(text: string): { name: string; index: number; total: number } | null {
	const match = text.match(/Current Phase:\s*(.+?)\s*\((\d+)\/(\d+)\)/);
	if (!match) return null;
	return { name: match[1], index: parseInt(match[2]), total: parseInt(match[3]) };
}

function buildInitialPhases(firstName: string, total: number): WorkflowPhaseStatus[] {
	const phases: WorkflowPhaseStatus[] = [];
	for (let i = 0; i < total; i++) {
		phases.push({
			id: `phase-${i}`,
			name: i === 0 ? firstName : `Phase ${i + 1}`,
			status: i === 0 ? "active" : "pending",
		});
	}
	return phases;
}

function ensurePhaseCount(status: WorkflowStatus, total: number): void {
	while (status.phases.length < total) {
		status.phases.push({
			id: `phase-${status.phases.length}`,
			name: `Phase ${status.phases.length + 1}`,
			status: "pending",
		});
	}
}

// ── Phase node colors ──

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
	completed: { bg: "bg-green-500/15", border: "border-green-500/40", text: "text-green-600 dark:text-green-400", dot: "bg-green-500" },
	active:    { bg: "bg-blue-500/15", border: "border-blue-500/40", text: "text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
	failed:    { bg: "bg-red-500/15", border: "border-red-500/40", text: "text-red-600 dark:text-red-400", dot: "bg-red-500" },
	pending:   { bg: "bg-muted/50", border: "border-border", text: "text-muted-foreground", dot: "bg-muted-foreground/40" },
	reset:     { bg: "bg-yellow-500/15", border: "border-yellow-500/40", text: "text-yellow-600 dark:text-yellow-400", dot: "bg-yellow-500" },
};

/**
 * Workflow status bar — pinned below the nav bar during active workflows.
 *
 * Shows phase nodes connected by arrows, with progress indication.
 * Clickable completed nodes can open artifacts (e.g., report in new tab).
 */
@customElement("workflow-status-bar")
export class WorkflowStatusBar extends LitElement {
	@property({ attribute: false }) status: WorkflowStatus | null = null;

	createRenderRoot() {
		return this;
	}

	override updated() {
		const active = this.querySelector(".wf-node-active") as HTMLElement | null;
		if (active) {
			active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
		}
	}

	override render() {
		if (!this.status || this.status.phases.length === 0) return html``;

		const { workflowName, phases, overallStatus, reportUrl } = this.status;

		const overallColor = overallStatus === "completed" ? "text-green-600 dark:text-green-400"
			: overallStatus === "failed" ? "text-red-600 dark:text-red-400"
			: "text-blue-600 dark:text-blue-400";

		return html`
			<div class="workflow-status-bar shrink-0">
				<!-- Header row: workflow name + overall status -->
				<div class="flex items-center justify-between px-3 pt-2 pb-1">
					<span class="text-xs font-medium text-foreground truncate">${workflowName}</span>
					<div class="flex items-center gap-2">
						${reportUrl ? html`
							<a href="#" @click=${(e: Event) => { e.preventDefault(); this.openReport(); }}
								class="text-[10px] text-blue-500 hover:underline whitespace-nowrap cursor-pointer">
								View Report ↗
							</a>
						` : ""}
						<span class="text-[10px] font-medium ${overallColor} uppercase tracking-wide">${overallStatus}</span>
					</div>
				</div>

				<!-- Phase pipeline -->
				<div class="px-3 pb-2 overflow-x-auto" style="-ms-overflow-style: none; scrollbar-width: none;">
					<div class="flex items-center gap-0 min-w-max">
						${phases.map((phase, i) => html`
							${i > 0 ? this.renderConnector(phases[i - 1].status, phase.status) : ""}
							${this.renderPhaseNode(phase, i)}
						`)}
					</div>
				</div>
			</div>
		`;
	}

	private renderPhaseNode(phase: WorkflowPhaseStatus, index: number): TemplateResult {
		const colors = STATUS_COLORS[phase.status] || STATUS_COLORS.pending;
		const isClickable = phase.status === "completed" && this.status?.reportUrl;
		// Mark the scroll-to target: active phase, or last phase if workflow is done
		const isScrollTarget = phase.status === "active" || phase.status === "failed"
			|| (this.status?.overallStatus !== "running" && index === (this.status?.phases.length ?? 0) - 1);

		const node = html`
			<div class="flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] whitespace-nowrap
				${colors.bg} ${colors.border} ${colors.text}
				${isClickable ? "cursor-pointer hover:brightness-110" : ""}
				${isScrollTarget ? "wf-node-active" : ""}"
				@click=${isClickable ? () => this.openReport() : undefined}
				title=${phase.name + (isClickable ? " (click to view report)" : "")}
			>
				<span class="w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}
					${phase.status === "active" ? "animate-pulse" : ""}"></span>
				<span class="leading-none">${phase.name}</span>
			</div>
		`;

		return node;
	}

	private async openReport() {
		const url = this.status?.reportUrl;
		if (!url) return;
		try {
			const token = localStorage.getItem("gateway.token");
			const resp = await fetch(url, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			if (!resp.ok) return;
			const html = await resp.text();
			const blob = new Blob([html], { type: "text/html" });
			window.open(URL.createObjectURL(blob), "_blank");
		} catch { /* ignore */ }
	}

	private renderConnector(prevStatus: string, _nextStatus: string): TemplateResult {
		const filled = prevStatus === "completed";
		return html`
			<div class="flex items-center px-0.5 shrink-0">
				<svg width="16" height="8" viewBox="0 0 16 8" class="${filled ? "text-green-500/60" : "text-muted-foreground/30"}">
					<path d="M0 4 L12 4 M9 1 L13 4 L9 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
		`;
	}
}
