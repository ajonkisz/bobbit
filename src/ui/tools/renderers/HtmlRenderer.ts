import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AppWindow, Loader2 } from "lucide";
import { icon } from "@mariozechner/mini-lit";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface HtmlWriteParams {
	path: string;
	content: string;
}

/**
 * Renders HTML files written via the `write` tool inline in the chat.
 * Shows a sandboxed iframe preview with the source code collapsible underneath.
 *
 * During streaming, we show a static placeholder instead of a live iframe to
 * avoid the white flash caused by repeatedly replacing iframe srcdoc. The full
 * interactive preview appears once the write completes.
 */
export class HtmlRenderer implements ToolRenderer<HtmlWriteParams, any> {
	render(
		params: HtmlWriteParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		const headerText = params?.path ? `HTML ${params.path}` : "HTML";

		// Error state
		if (result?.isError) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, AppWindow, headerText)}
						<div class="text-sm text-destructive">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const htmlContent = params?.content || "";
		const hasHtml = htmlContent.includes("<") && (htmlContent.includes("<html") || htmlContent.includes("<body") || htmlContent.includes("<div") || htmlContent.includes("<!DOCTYPE") || htmlContent.includes("<svg"));

		// No content yet (streaming hasn't delivered the content param)
		if (!hasHtml) {
			return { content: renderHeader(state, AppWindow, headerText), isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		// During streaming, show a placeholder instead of a live iframe to avoid flashing
		if (isStreaming) {
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
						<div class="mt-3 rounded-lg border border-border overflow-hidden"
							style="height: 200px; display: flex; align-items: center; justify-content: center; background: rgba(15, 15, 25, 0.85);">
							<div style="display: flex; flex-direction: column; align-items: center; gap: 10px; color: rgba(255,255,255,0.5);">
								<style>
									@keyframes html-renderer-spin {
										to { transform: rotate(360deg); }
									}
								</style>
								<div style="
									width: 22px; height: 22px;
									border: 2px solid rgba(255,255,255,0.12);
									border-top-color: rgba(255,255,255,0.5);
									border-radius: 50%;
									animation: html-renderer-spin 0.8s linear infinite;
								"></div>
								<span style="font-size: 12px; letter-spacing: 0.5px;">Rendering preview…</span>
							</div>
						</div>
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${htmlContent} language="html"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Complete — show the live iframe preview
		const iframeRef = createRef<HTMLIFrameElement>();

		const resizeIframe = () => {
			const iframe = iframeRef.value;
			if (!iframe?.contentDocument?.body) return;
			const body = iframe.contentDocument.body;
			const height = Math.min(body.scrollHeight + 16, 600);
			iframe.style.height = `${height}px`;
		};

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
					<div class="mt-3 rounded-lg border border-border overflow-hidden">
						<iframe
							${ref(iframeRef)}
							sandbox="allow-scripts allow-same-origin"
							.srcdoc=${htmlContent}
							@load=${resizeIframe}
							style="width: 100%; height: 300px; border: none; background: white;"
							title=${params?.path || "HTML preview"}
						></iframe>
					</div>
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<code-block .code=${htmlContent} language="html"></code-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
