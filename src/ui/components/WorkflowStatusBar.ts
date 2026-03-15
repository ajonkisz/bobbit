import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

/** Status for a sub-agent within a parallel phase */
export interface SubAgentStatus {
	phaseId: string;
	name: string;
	status: "pending" | "running" | "completed" | "failed" | "timeout";
	durationMs?: number;
	artifactName?: string;
}

/** Minimal workflow state extracted from tool call results */
export interface WorkflowPhaseStatus {
	id: string;
	name: string;
	status: "pending" | "active" | "completed" | "failed" | "reset";
	/** Sub-agents for parallel-group phases */
	subAgents?: SubAgentStatus[];
	/** Whether this phase is a parallel group */
	isParallelGroup?: boolean;
}

export interface WorkflowStatus {
	workflowId: string;
	workflowName: string;
	phases: WorkflowPhaseStatus[];
	overallStatus: "running" | "completed" | "failed" | "cancelled";
	reportUrl?: string;
	/** Session ID — needed for constructing artifact URLs */
	sessionId?: string;
}

/**
 * Extract workflow status from the message stream by parsing workflow tool results.
 *
 * Scans all messages for workflow tool calls and their results to reconstruct
 * the current state of the workflow. Also checks `streamMessage` and
 * `toolPartialResults` for in-progress tool calls (e.g., run_phase emitting
 * progress as sub-agents complete).
 */
export function extractWorkflowStatus(
	messages: any[],
	sessionId?: string,
	streamMessage?: any,
	toolPartialResults?: Record<string, any>,
): WorkflowStatus | null {
	let status: WorkflowStatus | null = null;
	const workflowToolCallIds = new Set<string>();
	/** Track which action each tool call had, to correlate with results */
	const toolCallActions = new Map<string, string>();

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type !== "toolCall" || block.name !== "workflow") continue;
				if (block.id) {
					workflowToolCallIds.add(block.id);
					if (block.arguments?.action) {
						toolCallActions.set(block.id, block.arguments.action);
					}
				}
				const args = block.arguments;
				if (!args?.action) continue;

				const action = args.action;

				if (action === "start" && args.workflow_id) {
					status = {
						workflowId: args.workflow_id,
						workflowName: args.workflow_id.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
						phases: [],
						overallStatus: "running",
						sessionId,
					};
				}

				// Bootstrap status from any workflow action if start was lost (e.g., after compaction)
				if (!status && ["status", "advance", "run_phase", "collect_artifact", "set_context", "complete", "fail", "cancel"].includes(action)) {
					status = {
						workflowId: args.workflow_id || "unknown",
						workflowName: "Workflow",
						phases: [],
						overallStatus: "running",
						sessionId,
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

			const action = toolCallActions.get(msg.toolCallId);

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

				// Detect parallel-group and sub-agent phases from start text
				detectSubAgentPhases(status, text);
			}

			// Detect run_phase result — parallel sub-agent progress
			if (action === "run_phase") {
				parseRunPhaseResult(status, text);
			}

			// Detect advance result — "Completed: X | Next: Y (n/total)"
			const advanceMatch = text.match(/Completed:\s*(.+?)\s*\|\s*Next:\s*(.+?)\s*\((\d+)\/(\d+)\)/);
			if (advanceMatch) {
				const completedName = advanceMatch[1];
				const nextName = advanceMatch[2];
				const nextIndex = parseInt(advanceMatch[3]) - 1; // 0-based
				const total = parseInt(advanceMatch[4]);
				const completedIndex = nextIndex - 1;

				// Ensure we have enough phases
				ensurePhaseCount(status, total);

				// Update completed phase name and status (may have been a generic "Phase N")
				if (completedIndex >= 0 && status.phases[completedIndex]) {
					status.phases[completedIndex].name = completedName;
					status.phases[completedIndex].status = "completed";
				} else {
					// Fallback: find by name
					const completedPhase = status.phases.find((p) => p.name === completedName);
					if (completedPhase) completedPhase.status = "completed";
				}

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

				// Detect sub-agent info in the new phase's instructions
				detectSubAgentPhases(status, text);
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

	// ── Check for in-progress workflow tool calls (streaming + partial results) ──
	// This surfaces real-time sub-agent progress during run_phase execution.
	if (status && toolPartialResults && Object.keys(toolPartialResults).length > 0) {
		// Find workflow tool call IDs that have partial results but no completed result yet.
		// These are in-progress tool calls. Check both streamMessage and messages for the
		// tool call block to determine the action.
		const pendingToolCalls = new Map<string, string>(); // id → action

		// Check streamMessage for in-progress tool calls
		if (streamMessage?.content && Array.isArray(streamMessage.content)) {
			for (const block of streamMessage.content) {
				if (block.type === "toolCall" && block.name === "workflow" && block.id && block.arguments?.action) {
					pendingToolCalls.set(block.id, block.arguments.action);
				}
			}
		}

		// Also check the last few messages — the tool call message might be deferred
		// (still shown in streaming container but logically part of messages)
		for (let i = messages.length - 1; i >= Math.max(0, messages.length - 5); i--) {
			const msg = messages[i];
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			for (const block of msg.content) {
				if (block.type === "toolCall" && block.name === "workflow" && block.id && block.arguments?.action) {
					pendingToolCalls.set(block.id, block.arguments.action);
				}
			}
		}

		// Also use toolCallActions collected during the main scan
		for (const [id, action] of toolCallActions) {
			if (toolPartialResults[id] && !pendingToolCalls.has(id)) {
				pendingToolCalls.set(id, action);
			}
		}

		for (const [tcId, action] of pendingToolCalls) {
			const partial = toolPartialResults[tcId];
			if (!partial) continue;

			const partialText = partial.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

			if (action === "run_phase" && partialText) {
				parseRunPhaseResult(status, partialText);
			}
		}
	}

	return status;
}

/** Extract workflow tool calls from the streaming message (in-progress assistant turn) */
function extractStreamingWorkflowToolCalls(streamMessage: any): Array<{ id: string; action: string }> {
	const calls: Array<{ id: string; action: string }> = [];
	if (!streamMessage?.content || !Array.isArray(streamMessage.content)) return calls;
	for (const block of streamMessage.content) {
		if (block.type === "toolCall" && block.name === "workflow" && block.id && block.arguments?.action) {
			calls.push({ id: block.id, action: block.arguments.action });
		}
	}
	return calls;
}

/**
 * Parse the output of a `run_phase` action to extract sub-agent progress.
 *
 * Expected text patterns from the workflow extension:
 *   "Running N sub-agents in parallel..."
 *   "Sub-phases: Name1 (isolation: full), Name2 (isolation: full), ..."
 *   "### ✓ phase-id (completed, 42s)"
 *   "### ✗ phase-id (failed, 10s)"
 *   "### ⏱ phase-id (timeout, 600s)"
 *   "Output collected as artifact: sub-agent-{phaseId}.txt"
 *   "**Summary:** 2/3 sub-agents completed successfully."
 *
 * For single sub-agent phases:
 *   "Running sub-agent for phase "Name" (isolation: full)..."
 *   "### ✓ phase-id (completed, 42s)"
 */
function parseRunPhaseResult(status: WorkflowStatus, text: string): void {
	const activePhase = status.phases.find((p) => p.status === "active");
	if (!activePhase) return;

	// Parse sub-phase names from "Sub-phases: ..." or "Phases: ..." line to get initial count and names
	const subPhasesMatch = text.match(/(?:Sub-phases|Phases):\s*(.+)/);
	if (subPhasesMatch && text.match(/parallel|sub-agent/i)) {
		activePhase.isParallelGroup = true;
	}

	// Parse individual sub-agent results:
	//   "### ✓ phase-id (completed, 42s)" — completed with duration
	//   "### ⏳ phase-id (running)"        — in-progress without duration
	//   "### ⏳ phase-id (running, 0s)"    — in-progress with duration
	// These contain the REAL phase IDs from the workflow definition, so we use them as the source of truth.
	const resultRegex = /###\s*([✓✗⏱⏳])\s*(\S+)\s*\((\w+)(?:,\s*(\d+)s)?\)/g;
	let match;
	const seenPhaseIds: string[] = [];
	while ((match = resultRegex.exec(text)) !== null) {
		const [, icon, phaseId, _resultStatus, durationStr] = match;
		seenPhaseIds.push(phaseId);
		const durationMs = durationStr ? parseInt(durationStr) * 1000 : undefined;
		const normalizedStatus = icon === "✓" ? "completed"
			: icon === "⏱" ? "timeout"
			: icon === "⏳" ? "running"
			: "failed";

		// Prettify the phaseId into a display name: "review-correctness" → "Review Correctness"
		const prettyName = phaseId.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

		if (!activePhase.subAgents) activePhase.subAgents = [];

		// Find existing by exact phaseId match
		let sub = activePhase.subAgents.find((s) => s.phaseId === phaseId);
		if (sub) {
			sub.status = normalizedStatus as SubAgentStatus["status"];
			sub.durationMs = durationMs;
		} else {
			// Try positional match (i-th result line → i-th sub-agent)
			const idx = seenPhaseIds.length - 1;
			if (idx < activePhase.subAgents.length && !seenPhaseIds.slice(0, -1).includes(activePhase.subAgents[idx].phaseId)) {
				// Update the placeholder entry with the real phaseId
				sub = activePhase.subAgents[idx];
				sub.phaseId = phaseId;
				sub.name = prettyName;
				sub.status = normalizedStatus as SubAgentStatus["status"];
				sub.durationMs = durationMs;
			} else {
				activePhase.subAgents.push({
					phaseId,
					name: prettyName,
					status: normalizedStatus as SubAgentStatus["status"],
					durationMs,
				});
			}
		}
	}

	// If we saw phase names but no result lines yet, create placeholder entries from names
	if (subPhasesMatch && (!activePhase.subAgents || activePhase.subAgents.length === 0)) {
		const subPhaseEntries = subPhasesMatch[1].split(",").map((s: string) => s.trim());
		activePhase.subAgents = subPhaseEntries.map((entry: string) => {
			// Handle "Name (isolation: full)" or just "Name"
			const nameMatch = entry.match(/^(.+?)\s*\(isolation:/);
			const name = nameMatch ? nameMatch[1].trim() : entry.trim();
			return { phaseId: name, name, status: "running" as const };
		});
	}

	// Parse artifact references and assign to sub-agents by phaseId.
	// Artifact names are "sub-agent-{phaseId}.txt" where phaseId is the REAL ID.
	// If we found multiple sub-agents via result lines, mark as parallel group
	if (activePhase.subAgents && activePhase.subAgents.length > 1) {
		activePhase.isParallelGroup = true;
	}

	// Parse artifact references and assign to sub-agents by phaseId.
	const artifactRegex = /Output collected as artifact:\s*(sub-agent-(\S+?)\.txt)/g;
	let artMatch;
	while ((artMatch = artifactRegex.exec(text)) !== null) {
		const [, artifactName, artPhaseId] = artMatch;
		if (activePhase.subAgents) {
			const sub = activePhase.subAgents.find((s) => s.phaseId === artPhaseId);
			if (sub) sub.artifactName = artifactName;
		}
	}
}

/**
 * Detect phases that are sub-agent or parallel-group from execution description.
 * Looks for "Execution: parallel-group (N sub-agents)" or "Execution: sub-agent"
 * in the phase instructions text.
 */
function detectSubAgentPhases(status: WorkflowStatus, text: string): void {
	// "Execution: parallel-group (3 sub-agents)"
	const parallelMatch = text.match(/\*\*Execution:\*\*\s*parallel-group\s*\((\d+)\s*sub-agents?\)/);
	if (parallelMatch) {
		const activePhase = status.phases.find((p) => p.status === "active");
		if (activePhase) {
			activePhase.isParallelGroup = true;
			if (!activePhase.subAgents) {
				const count = parseInt(parallelMatch[1]);
				activePhase.subAgents = Array.from({ length: count }, (_, i) => ({
					phaseId: `sub-${i}`,
					name: `Sub-agent ${i + 1}`,
					status: "pending" as const,
				}));
			}
		}
	}

	// "Execution: sub-agent (isolation: full)"
	const subAgentMatch = text.match(/\*\*Execution:\*\*\s*sub-agent\s*\(isolation:\s*(\w+)\)/);
	if (subAgentMatch && !parallelMatch) {
		const activePhase = status.phases.find((p) => p.status === "active");
		if (activePhase && !activePhase.subAgents) {
			activePhase.subAgents = [{
				phaseId: activePhase.id,
				name: activePhase.name,
				status: "pending",
			}];
		}
	}
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
	running:   { bg: "bg-blue-500/15", border: "border-blue-500/40", text: "text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
	timeout:   { bg: "bg-orange-500/15", border: "border-orange-500/40", text: "text-orange-600 dark:text-orange-400", dot: "bg-orange-500" },
};

/**
 * Workflow status bar — pinned below the nav bar during active workflows.
 *
 * Shows phase nodes connected by arrows, with progress indication.
 * Parallel-group phases expand inline into a DAG fork/merge structure
 * showing each sub-agent as a vertical branch.
 * Sub-agent log artifacts are clickable to view output.
 */
@customElement("workflow-status-bar")
export class WorkflowStatusBar extends LitElement {
	@property({ attribute: false }) status: WorkflowStatus | null = null;
	private _lastActivePhase: string | null = null;
	private _expandedParallel: Set<string> = new Set();

	createRenderRoot() {
		return this;
	}

	override updated() {
		const active = this.querySelector(".wf-node-active") as HTMLElement | null;
		if (!active) return;

		const activeId = active.getAttribute("data-phase-id");
		if (activeId === this._lastActivePhase) return;
		this._lastActivePhase = activeId;

		const pipeline = active.closest(".overflow-x-auto");
		if (pipeline) {
			const containerRect = pipeline.getBoundingClientRect();
			const activeRect = active.getBoundingClientRect();
			const targetScroll = pipeline.scrollLeft + (activeRect.left - containerRect.left)
				- (containerRect.width / 2) + (activeRect.width / 2);
			pipeline.scrollTo({ left: targetScroll, behavior: "smooth" });
		}
	}

	/** Is a parallel phase currently expanded? Auto-expand active parallel phases. */
	private isExpanded(phase: WorkflowPhaseStatus): boolean {
		if (!phase.subAgents || phase.subAgents.length === 0) return false;
		return this._expandedParallel.has(phase.id) || phase.status === "active";
	}

	override render() {
		if (!this.status || this.status.phases.length === 0) return html``;

		const { workflowName, phases, overallStatus, reportUrl } = this.status;

		const overallColor = overallStatus === "completed" ? "text-green-600 dark:text-green-400"
			: overallStatus === "failed" ? "text-red-600 dark:text-red-400"
			: "text-blue-600 dark:text-blue-400";

		return html`
			<div class="workflow-status-bar shrink-0 py-1.5 md:py-2 flex flex-col gap-1 md:gap-2">
				<!-- Header row -->
				<div class="flex items-center justify-between px-3">
					<span class="text-xs font-medium text-foreground truncate">
						<span class="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mr-1.5">Workflow:</span>${workflowName}
					</span>
					<div class="flex items-center gap-2">
						${reportUrl ? html`
							<button @click=${() => this.openReport()}
								class="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-[10px] text-blue-600 dark:text-blue-400 font-medium hover:bg-blue-500/20 transition-colors whitespace-nowrap cursor-pointer">
								View Report
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
									<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
								</svg>
							</button>
						` : ""}
						<span class="text-[10px] font-medium ${overallColor} uppercase tracking-wide">${overallStatus}</span>
					</div>
				</div>

				<!-- Phase pipeline (DAG) -->
				<div class="px-3 overflow-x-auto" style="-ms-overflow-style: none; scrollbar-width: none;">
					<div class="flex items-center gap-0 min-w-max">
						${phases.map((phase, i) => {
							const expanded = this.isExpanded(phase);
							if (expanded) {
								// Expanded parallel: render fork → sub-agents → merge inline
								return html`
									${i > 0 ? this.renderConnector(phases[i - 1].status, phase.status) : ""}
									${this.renderParallelDAG(phase, i)}
								`;
							}
							return html`
								${i > 0 ? this.renderConnector(phases[i - 1].status, phase.status) : ""}
								${this.renderPhaseNode(phase, i)}
							`;
						})}
					</div>
				</div>
			</div>
		`;
	}

	// ── Regular (collapsed) phase node ──

	private renderPhaseNode(phase: WorkflowPhaseStatus, index: number): TemplateResult {
		const colors = STATUS_COLORS[phase.status] || STATUS_COLORS.pending;
		const isClickable = phase.status === "completed" && this.status?.reportUrl;
		const hasSubAgents = phase.subAgents && phase.subAgents.length > 0;
		const isExpandable = hasSubAgents;
		const isScrollTarget = phase.status === "active" || phase.status === "failed"
			|| (this.status?.overallStatus !== "running" && index === (this.status?.phases.length ?? 0) - 1);

		let subProgress = "";
		if (hasSubAgents && phase.subAgents!.length > 1) {
			const done = phase.subAgents!.filter((s) => s.status === "completed" || s.status === "failed" || s.status === "timeout").length;
			subProgress = ` ${done}/${phase.subAgents!.length}`;
		}

		const handleClick = () => {
			if (isExpandable) {
				this.toggleExpanded(phase.id);
			} else if (isClickable) {
				this.openReport();
			}
		};

		return html`
			<div class="flex items-center gap-1.5 px-2 py-1 rounded-full border text-[11px] whitespace-nowrap
				${colors.bg} ${colors.border} ${colors.text}
				${isClickable || isExpandable ? "cursor-pointer hover:brightness-110" : ""}
				${isScrollTarget ? "wf-node-active" : ""}"
				data-phase-id=${phase.id}
				@click=${handleClick}
				title=${phase.name + (hasSubAgents ? ` (${phase.subAgents!.length} sub-agents — click to expand)` : isClickable ? " (click to view report)" : "")}
			>
				<span class="w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}
					${phase.status === "active" ? "animate-pulse" : ""}"></span>
				<span class="leading-none">${phase.name}</span>
				${hasSubAgents ? html`
					<span class="leading-none text-[10px] opacity-70">${subProgress}</span>
					${phase.isParallelGroup ? html`
						<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-60 shrink-0">
							<path d="M16 18 L22 12 L16 6"/><path d="M8 6 L2 12 L8 18"/>
						</svg>
					` : ""}
				` : ""}
			</div>
		`;
	}

	// ── Expanded parallel DAG: fork → vertical sub-agent stack → merge ──

	private renderParallelDAG(phase: WorkflowPhaseStatus, index: number): TemplateResult {
		const subs = phase.subAgents!;
		const sessionId = this.status?.sessionId;
		const n = subs.length;

		// Geometry for the fork/merge SVG curves
		const CHIP_H = 26;  // height of each sub-agent chip (px)
		const CHIP_GAP = 5; // vertical gap between chips
		const FORK_W = 24;  // width of the fork/merge SVG
		const totalH = n * CHIP_H + (n - 1) * CHIP_GAP;
		const centerY = totalH / 2;

		const isScrollTarget = phase.status === "active" || phase.status === "failed"
			|| (this.status?.overallStatus !== "running" && index === (this.status?.phases.length ?? 0) - 1);

		// Determine line color based on phase status
		const lineColor = phase.status === "completed" ? "var(--color-green-500, #22c55e)"
			: phase.status === "failed" ? "var(--color-red-500, #ef4444)"
			: "var(--color-blue-500, #3b82f6)";
		const lineOpacity = phase.status === "pending" ? 0.3 : 0.5;

		return html`
			<div class="flex flex-col items-center ${isScrollTarget ? "wf-node-active" : ""}"
				data-phase-id=${phase.id}>
				<!-- Phase label above the DAG (click to collapse) -->
				<button class="flex items-center gap-1 px-1.5 py-0.5 mb-1 rounded-full cursor-pointer
					text-[9px] text-muted-foreground font-medium uppercase tracking-wider select-none
					hover:bg-muted/50 transition-colors border border-transparent hover:border-border"
					@click=${() => this.toggleExpanded(phase.id)}
					title="Click to collapse">
					<span class="leading-none">${phase.name}</span>
					<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor"
						stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
						class="opacity-50">
						<polyline points="18 15 12 9 6 15"/>
					</svg>
				</button>

				<!-- Fork → chips → merge row -->
				<div class="flex items-center">
					<!-- Fork SVG -->
					<svg width="${FORK_W}" height="${totalH}" class="shrink-0" style="display: block;">
						${subs.map((_, i) => {
							const y = i * (CHIP_H + CHIP_GAP) + CHIP_H / 2;
							return html`
								<path d="M 0,${centerY} C ${FORK_W * 0.5},${centerY} ${FORK_W * 0.5},${y} ${FORK_W},${y}"
									fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-opacity="${lineOpacity}"
									stroke-linecap="round"/>
							`;
						})}
					</svg>

					<!-- Vertical stack of sub-agent chips -->
					<div class="flex flex-col" style="gap: ${CHIP_GAP}px;">
						${subs.map((sub) => this.renderSubAgentChip(sub, sessionId))}
					</div>

					<!-- Merge SVG -->
					<svg width="${FORK_W}" height="${totalH}" class="shrink-0" style="display: block;">
						${subs.map((_, i) => {
							const y = i * (CHIP_H + CHIP_GAP) + CHIP_H / 2;
							return html`
								<path d="M 0,${y} C ${FORK_W * 0.5},${y} ${FORK_W * 0.5},${centerY} ${FORK_W},${centerY}"
									fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-opacity="${lineOpacity}"
									stroke-linecap="round"/>
							`;
						})}
					</svg>
				</div>
			</div>
		`;
	}

	// ── Sub-agent chip (used inside the DAG) ──
	// Same pill shape as top-level phase nodes. Entire chip is clickable to open log.

	private renderSubAgentChip(sub: SubAgentStatus, sessionId?: string): TemplateResult {
		const colors = STATUS_COLORS[sub.status] || STATUS_COLORS.pending;
		const duration = sub.durationMs ? formatDuration(sub.durationMs) : "";
		const hasLogs = !!sub.artifactName && !!sessionId;

		return html`
			<div class="inline-flex items-center gap-1.5 px-2 rounded-full border whitespace-nowrap
				${colors.bg} ${colors.border} ${colors.text}
				${hasLogs ? "cursor-pointer hover:brightness-110" : ""}"
				style="height: 26px; font-size: 11px;"
				@click=${hasLogs ? () => this.openSubAgentLog(sessionId!, sub.artifactName!) : undefined}
				title=${hasLogs ? `${sub.name} — click to view log` : sub.name}>
				<span class="w-1.5 h-1.5 rounded-full shrink-0 ${colors.dot}
					${sub.status === "running" ? "animate-pulse" : ""}"></span>
				<span class="leading-none">${sub.name}</span>
				${duration ? html`<span class="leading-none opacity-60 text-[10px]">${duration}</span>` : ""}
				${hasLogs ? html`
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-50 shrink-0">
						<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
					</svg>
				` : ""}
			</div>
		`;
	}

	// ── Helpers ──

	private toggleExpanded(phaseId: string) {
		if (this._expandedParallel.has(phaseId)) {
			this._expandedParallel.delete(phaseId);
		} else {
			this._expandedParallel.add(phaseId);
		}
		this.requestUpdate();
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
			const htmlContent = await resp.text();
			const blob = new Blob([htmlContent], { type: "text/html" });
			window.open(URL.createObjectURL(blob), "_blank");
		} catch { /* ignore */ }
	}

	private async openSubAgentLog(sessionId: string, artifactName: string) {
		const url = `/api/sessions/${sessionId}/workflow/artifacts/${encodeURIComponent(artifactName)}`;
		try {
			const token = localStorage.getItem("gateway.token");
			const resp = await fetch(url, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			if (!resp.ok) return;
			const text = await resp.text();
			const htmlContent = subAgentLogHtml(artifactName, text);
			const blob = new Blob([htmlContent], { type: "text/html" });
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

/** Format milliseconds to a short human-readable duration */
function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

/** Wrap sub-agent log text in a styled HTML document for viewing */
function subAgentLogHtml(title: string, logText: string): string {
	const escaped = logText
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<title>${title}</title>
	<style>
		body {
			font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
			font-size: 13px;
			line-height: 1.6;
			background: #0d1117;
			color: #c9d1d9;
			padding: 24px 32px;
			margin: 0;
		}
		h1 {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 16px;
			font-weight: 600;
			color: #58a6ff;
			margin: 0 0 16px 0;
			padding-bottom: 8px;
			border-bottom: 1px solid #21262d;
		}
		.log-section { margin-bottom: 16px; }
		.label {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
			font-size: 11px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: #8b949e;
			margin-bottom: 4px;
		}
		pre {
			white-space: pre-wrap;
			word-wrap: break-word;
			margin: 0;
			padding: 12px 16px;
			background: #161b22;
			border-radius: 6px;
			border: 1px solid #21262d;
		}
	</style>
</head>
<body>
	<h1>Sub-Agent Log: ${title.replace(/\.txt$/, "")}</h1>
	<pre>${escaped}</pre>
</body>
</html>`;
}
