/**
 * Renderers for personalities_list and personalities_create tools.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Sparkles, Plus } from "lucide";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── personalities_list ───────────────────────────────────────────────

export class PersonalitiesListRenderer implements ToolRenderer {
	render(_params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		if (!result) {
			return { content: html`<div>${renderHeader(state, Sparkles, "Listing personalities…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			return {
				content: html`<div>
					${renderHeader(state, Sparkles, "Personality list failed")}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const personalities: any[] = Array.isArray(data) ? data : (data?.personalities || []);
		if (personalities.length === 0) {
			return { content: html`<div>${renderHeader(state, Sparkles, "No personalities defined")}</div>`, isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, Sparkles, html`${personalities.length} personalit${personalities.length !== 1 ? "ies" : "y"}`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">
						${personalities.map((p: any) => html`
							<div class="flex items-center gap-2 text-xs py-0.5">
								<span class="px-1.5 py-0.5 rounded font-medium bg-violet-500/20 text-violet-600 dark:text-violet-400">${p.name}</span>
								<span class="text-muted-foreground truncate">${truncate(p.description || "", 50)}</span>
							</div>
						`)}
					</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── personalities_create ─────────────────────────────────────────────

export class PersonalitiesCreateRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const name = params?.name || "personality";
		const desc = params?.description ? truncate(params.description, 60) : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, Plus, html`Creating personality <span class="px-1.5 py-0.5 rounded font-medium text-xs bg-violet-500/20 text-violet-600 dark:text-violet-400">${name}</span> ${desc ? html`— <span class="text-xs text-muted-foreground">${desc}</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Plus, html`Failed to create personality <span class="font-medium text-xs">${name}</span>`)}
					<div class="mt-1 text-xs text-destructive">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, Plus, html`Created personality <span class="px-1.5 py-0.5 rounded font-medium text-xs bg-violet-500/20 text-violet-600 dark:text-violet-400">${name}</span> ${desc ? html`— <span class="text-xs text-muted-foreground">${desc}</span>` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}
