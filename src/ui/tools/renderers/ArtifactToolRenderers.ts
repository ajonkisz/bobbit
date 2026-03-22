/**
 * Renderers for artifact_list, artifact_create, artifact_get, artifact_update tools.
 * Compact artifact cards with type badges and version info.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileText, FilePlus, FileSearch, FilePen } from "lucide";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function artifactTypeBadge(type: string): TemplateResult {
	const styles: Record<string, string> = {
		"design-doc": "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400",
		"test-plan": "bg-green-500/20 text-green-600 dark:text-green-400",
		"review-findings": "bg-purple-500/20 text-purple-600 dark:text-purple-400",
		"gap-analysis": "bg-amber-500/20 text-amber-600 dark:text-amber-400",
		"security-findings": "bg-red-500/20 text-red-600 dark:text-red-400",
		"pr": "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
		custom: "bg-muted text-muted-foreground",
	};
	const cls = styles[type] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${type}</span>`;
}

function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── artifact_list ────────────────────────────────────────────────────

export class ArtifactListRenderer implements ToolRenderer {
	render(_params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		if (!result) {
			return { content: html`<div>${renderHeader(state, FileText, "Listing artifacts…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			return {
				content: html`<div>
					${renderHeader(state, FileText, "Artifact list failed")}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const artifacts: any[] = data?.artifacts || (Array.isArray(data) ? data : []);
		if (artifacts.length === 0) {
			return { content: html`<div>${renderHeader(state, FileText, "No artifacts")}</div>`, isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, FileText, html`${artifacts.length} artifact${artifacts.length !== 1 ? "s" : ""}`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">
						${artifacts.map((a: any) => html`
							<div class="flex items-center gap-2 text-xs py-0.5">
								${artifactTypeBadge(a.type || "custom")}
								<span class="font-medium">${truncate(a.name || "Untitled", 40)}</span>
								<span class="text-muted-foreground font-mono">v${a.version || 1}</span>
							</div>
						`)}
					</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── artifact_create ──────────────────────────────────────────────────

export class ArtifactCreateRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const name = params?.name || "artifact";
		const type = params?.type;
		const contentLen = params?.content ? `${(params.content.length / 1024).toFixed(1)}KB` : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, FilePlus, html`Creating ${type ? artifactTypeBadge(type) : ""} <span class="font-medium text-xs">${truncate(name)}</span> ${contentLen ? html`<span class="text-xs text-muted-foreground">(${contentLen})</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			return {
				content: html`<div>
					${renderHeader(state, FilePlus, html`Failed to create artifact — <span class="font-medium text-xs">${truncate(name)}</span>`)}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const artId = data?.id ? data.id.slice(0, 8) : "";
		return {
			content: html`<div>${renderHeader(state, FilePlus, html`Created ${type ? artifactTypeBadge(type) : ""} <span class="font-medium text-xs">${truncate(name)}</span> ${artId ? html`<span class="text-xs text-muted-foreground font-mono">${artId}</span>` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}

// ── artifact_get ─────────────────────────────────────────────────────

export class ArtifactGetRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const artId = params?.artifact_id ? params.artifact_id.slice(0, 8) : "artifact";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, FileSearch, html`Reading artifact <span class="font-mono text-xs">${artId}</span>`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			return {
				content: html`<div>
					${renderHeader(state, FileSearch, html`Failed to read artifact`)}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const name = data?.name || "";
		const type = data?.type;
		const version = data?.version || 1;
		const contentLen = data?.content ? `${(data.content.length / 1024).toFixed(1)}KB` : "";

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, FileSearch,
					html`Read ${type ? artifactTypeBadge(type) : ""} <span class="font-medium text-xs">${truncate(name, 40)}</span> <span class="text-muted-foreground font-mono text-xs">v${version}</span> ${contentLen ? html`<span class="text-xs text-muted-foreground">(${contentLen})</span>` : ""}`,
					contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					${data?.content ? html`<code-block .code=${data.content} language="markdown" class="mt-2"></code-block>` : ""}
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── artifact_update ──────────────────────────────────────────────────

export class ArtifactUpdateRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const artId = params?.artifact_id ? params.artifact_id.slice(0, 8) : "artifact";
		const contentLen = params?.content ? `${(params.content.length / 1024).toFixed(1)}KB` : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, FilePen, html`Updating artifact <span class="font-mono text-xs">${artId}</span> ${contentLen ? html`<span class="text-xs text-muted-foreground">(${contentLen})</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			return {
				content: html`<div>
					${renderHeader(state, FilePen, html`Failed to update artifact`)}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const name = data?.name || "";
		const type = data?.type;
		const version = data?.version || 1;

		return {
			content: html`<div>${renderHeader(state, FilePen, html`Updated ${type ? artifactTypeBadge(type) : ""} <span class="font-medium text-xs">${truncate(name, 40)}</span> <span class="text-muted-foreground font-mono text-xs">→ v${version}</span>`)}</div>`,
			isCustom: false,
		};
	}
}
