import { html, type TemplateResult } from "lit";

/**
 * Extract image content blocks from tool result content array
 * and render them as inline <img> elements.
 */
export function renderInlineImages(content: any[] | undefined): TemplateResult {
	if (!content) return html``;

	const images = content.filter((c: any) => c.type === "image" && c.data && c.mimeType);
	if (images.length === 0) return html``;

	return html`
		<div class="flex flex-wrap gap-2 mt-2">
			${images.map(
				(img: any) => html`
					<img
						src="data:${img.mimeType};base64,${img.data}"
						alt="Tool output image"
						class="max-w-full rounded border border-border cursor-pointer"
						style="max-height: 400px; object-fit: contain;"
						@click=${(e: Event) => {
							const imgEl = e.target as HTMLImageElement;
							// Open in a new tab for full-size viewing
							const w = window.open("");
							if (w) {
								w.document.write(`<img src="${imgEl.src}" style="max-width:100%">`);
								w.document.title = "Image Preview";
							}
						}}
					/>
				`,
			)}
		</div>
	`;
}
