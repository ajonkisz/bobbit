import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Bot, ListChecks } from "lucide";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import {
	type DelegateCardEntry,
	formatDuration,
	getAuthToken,
	renderDelegateCardList,
	renderStatusPills,
} from "./delegate-cards.js";

interface RunPhaseDetails {
	delegates?: DelegateCardEntry[];
}

interface WorkflowParams {
	action: string;
	workflow_id?: string;
	phase_id?: string;
	name?: string;
	content?: string;
	mime_type?: string;
	key?: string;
	value?: string;
	reason?: string;
	context?: string;
}

function getTextOutput(result: ToolResultMessage<any> | undefined): string {
	if (!result) return "";
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** Extract an HTML report from the workflow result text if present */
function extractReportUrl(text: string): string | null {
	const match = text.match(/\/api\/sessions\/[^/]+\/workflow\/report/);
	return match ? match[0] : null;
}

/** Parse phase info from workflow result text */
function parsePhaseInfo(text: string): { name: string; index: number; total: number } | null {
	const match = text.match(/Current Phase:\s*(.+?)\s*\((\d+)\/(\d+)\)/);
	if (!match) return null;
	return { name: match[1], index: parseInt(match[2]), total: parseInt(match[3]) };
}

/** Parse advance result: "Completed: X | Next: Y (n/total)" */
function parseAdvanceInfo(text: string): { completedName: string; nextName: string; index: number; total: number } | null {
	const match = text.match(/Completed:\s*(.+?)\s*\|\s*Next:\s*(.+?)\s*\((\d+)\/(\d+)\)/);
	if (!match) return null;
	return { completedName: match[1], nextName: match[2], index: parseInt(match[3]), total: parseInt(match[4]) };
}

/** Get a human-readable action label */
function getActionLabel(action: string): { streaming: string; complete: string } {
	const labels: Record<string, { streaming: string; complete: string }> = {
		list: { streaming: "Listing workflows", complete: "Listed workflows" },
		start: { streaming: "Starting workflow", complete: "Started workflow" },
		status: { streaming: "Checking workflow status", complete: "Workflow status" },
		advance: { streaming: "Advancing phase", complete: "Advanced phase" },
		reset: { streaming: "Resetting phase", complete: "Reset phase" },
		run_phase: { streaming: "Delegating to agents", complete: "Delegates completed" },
		collect_artifact: { streaming: "Collecting artifact", complete: "Collected artifact" },
		set_context: { streaming: "Setting context", complete: "Set context" },
		complete: { streaming: "Completing workflow", complete: "Workflow completed" },
		fail: { streaming: "Failing workflow", complete: "Workflow failed" },
		cancel: { streaming: "Cancelling workflow", complete: "Workflow cancelled" },
	};
	return labels[action] || { streaming: "Running workflow", complete: "Workflow action" };
}

/** Render the workflow report inline in an iframe */
function renderReportInline(text: string): TemplateResult {
	const reportUrl = extractReportUrl(text);

	// Strip the report URL line from the display text — the iframe replaces it
	const displayText = text.replace(/\n?Report:?\s*\/api\/sessions\/[^\s]+/g, "").trim();

	return html`
		<div class="mt-3 space-y-3">
			${displayText ? html`<div class="text-sm whitespace-pre-wrap">${displayText}</div>` : ""}
			${reportUrl
				? html`
					<div style="border: 1px solid var(--border, #30363d); border-radius: 8px; overflow: hidden; margin-top: 8px;">
						<iframe
							sandbox="allow-scripts"
							style="width: 100%; height: 600px; border: none;"
							${ref((el: Element | undefined) => {
								if (el && el instanceof HTMLIFrameElement && !el.dataset.loaded) {
									el.dataset.loaded = "1";
									loadReportIntoIframe(el, reportUrl);
								}
							})}
						></iframe>
						<div style="padding: 6px 12px; border-top: 1px solid var(--border, #30363d); display: flex; justify-content: flex-end;">
							<a href="${reportUrl}" target="_blank" rel="noopener"
								class="text-xs text-muted-foreground hover:underline"
							>Open in new tab ↗</a>
						</div>
					</div>
				`
				: ""}
		</div>
	`;
}

/** Fetch the report HTML and inject it into the iframe via srcdoc */
async function loadReportIntoIframe(iframe: HTMLIFrameElement, reportUrl: string): Promise<void> {
	try {
		const token = getAuthToken();
		const resp = await fetch(reportUrl, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		if (!resp.ok) {
			iframe.srcdoc = errorPage(`Failed to load report: ${resp.status} ${resp.statusText}`);
			return;
		}
		iframe.srcdoc = await resp.text();
	} catch (err) {
		iframe.srcdoc = errorPage(`Failed to load report: ${err}`);
	}
}

function errorPage(message: string): string {
	return `<html><body style="font-family: -apple-system, sans-serif; padding: 20px; color: #f85149; background: #0d1117;">
		<p>${message}</p>
	</body></html>`;
}

// getAuthToken imported from delegate-cards.ts

export class WorkflowRenderer implements ToolRenderer<WorkflowParams, any> {
	render(
		params: WorkflowParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const action = params?.action || "unknown";
		const labels = getActionLabel(action);

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		// Completed with result
		if (result && params) {
			const output = getTextOutput(result);
			const reportUrl = extractReportUrl(output);
			const headerText = labels.complete;
			const isTerminal = action === "complete" || action === "fail" || action === "cancel";
			const hasReport = !!reportUrl;

			// For terminal actions with a report, show the report inline expanded by default
			if (isTerminal && hasReport) {
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, ListChecks, headerText, contentRef, chevronRef, true)}
							<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
								${renderReportInline(output)}
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// For advance: show "CompletedPhase Complete → Starting NextPhase (n/total)"
			if (action === "advance") {
				const advInfo = parseAdvanceInfo(output);
				const advanceHeader = advInfo
					? html`<strong>${advInfo.completedName}</strong> Phase Complete → Starting <strong>${advInfo.nextName}</strong> Phase <span class="text-muted-foreground">(${advInfo.index}/${advInfo.total})</span>`
					: output.includes("All phases complete")
						? html`All phases complete ✓`
						: headerText;
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, ListChecks, advanceHeader, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${output}</div>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// For start: show workflow name and first phase
			if (action === "start") {
				const phaseInfo = parsePhaseInfo(output);
				const startHeader = phaseInfo
					? html`Started workflow → <strong>${phaseInfo.name}</strong> <span class="text-muted-foreground">(${phaseInfo.index}/${phaseInfo.total})</span>`
					: headerText;
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, ListChecks, startHeader, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${output}</div>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// For run_phase: show individual delegate cards matching DelegateRenderer pattern
			if (action === "run_phase") {
				const details = result.details as RunPhaseDetails | undefined;
				const delegates = details?.delegates || [];
				const allOk = delegates.length > 0 && delegates.every((d) => d.status === "completed");
				const isRunning = isStreaming && delegates.some((d) => d.status === "running" || d.status === "starting");
				const showExpanded = isRunning || delegates.some((d) => d.sessionId);

				const runPhaseHeader = delegates.length > 0
					? html`Delegated to ${delegates.length} agents
					${renderStatusPills(delegates)}
					${allOk ? html`<span class="text-green-500 ml-1">All completed</span>` : ""}`
					: html`${headerText}`;

				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, Bot, runPhaseHeader, contentRef, chevronRef, showExpanded)}
							<div ${ref(contentRef)} class="${showExpanded ? "max-h-[2000px] mt-3" : "max-h-0"} overflow-hidden transition-all duration-300">
								${renderDelegateCardList(delegates)}
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// For status: show current phase
			if (action === "status") {
				const phaseInfo = parsePhaseInfo(output);
				const statusHeader = phaseInfo
					? html`Workflow status: <strong>${phaseInfo.name}</strong> <span class="text-muted-foreground">(${phaseInfo.index}/${phaseInfo.total})</span>`
					: headerText;
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, ListChecks, statusHeader, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${output}</div>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Default: brief actions (set_context, collect_artifact, etc.)
			if (action === "set_context" && params.key) {
				return {
					content: html`
						<div class="flex items-center gap-2 text-sm text-muted-foreground">
							<span class="text-green-600 dark:text-green-500">✓</span>
							Context: <code class="font-mono text-xs">${params.key}</code> = <code class="font-mono text-xs">${params.value}</code>
						</div>
					`,
					isCustom: false,
				};
			}

			if (action === "collect_artifact" && params.name) {
				const size = params.content?.length || 0;
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, ListChecks, html`Collected artifact: <code class="font-mono text-xs">${params.name}</code> <span class="text-muted-foreground">(${formatSize(size)})</span>`, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<div class="mt-2 text-sm text-muted-foreground">${output}</div>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Fallback
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, ListChecks, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<div class="mt-2 text-sm whitespace-pre-wrap text-muted-foreground">${output}</div>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Streaming / no result yet
		if (params) {
			return {
				content: html`
					<div>
						${renderHeader(state, ListChecks, labels.streaming)}
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, ListChecks, "Running workflow..."), isCustom: false };
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} chars`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}


