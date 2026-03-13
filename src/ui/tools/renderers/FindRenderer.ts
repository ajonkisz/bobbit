import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef } from "lit/directives/ref.js";
import { FileText } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface FindParams {
	pattern: string;
	path?: string;
	limit?: number;
}

export class FindRenderer implements ToolRenderer<FindParams, any> {
	render(params: FindParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		let headerText: string;
		if (params?.pattern) {
			headerText = params.path
				? `${i18n("Finding")} ${params.pattern} ${i18n("in")} ${params.path}`
				: `${i18n("Finding")} ${params.pattern}`;
		} else {
			headerText = i18n("Finding files...");
		}

		if (result) {
			const output = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

			if (result.isError) {
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, FileText, headerText)}
							<div class="text-sm text-destructive">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, FileText, headerText, contentRef, chevronRef, false)}
						<div ${contentRef} class="max-h-0 overflow-hidden transition-all duration-300">
							<console-block .content=${output}></console-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, FileText, headerText), isCustom: false };
	}
}
