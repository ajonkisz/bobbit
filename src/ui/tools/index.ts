import type { ToolResultMessage } from "@mariozechner/pi-ai";
import "./javascript-repl.js"; // Auto-registers the renderer
import "./extract-document.js"; // Auto-registers the renderer
import { getToolRenderer, registerToolRenderer } from "./renderer-registry.js";
import { BashRenderer } from "./renderers/BashRenderer.js";
import { DefaultRenderer } from "./renderers/DefaultRenderer.js";
import { EditRenderer } from "./renderers/EditRenderer.js";
import { FindRenderer } from "./renderers/FindRenderer.js";
import { GrepRenderer } from "./renderers/GrepRenderer.js";
import { LsRenderer } from "./renderers/LsRenderer.js";
import { ReadRenderer } from "./renderers/ReadRenderer.js";
import { WriteRenderer } from "./renderers/WriteRenderer.js";
import type { ToolRenderResult } from "./types.js";

// Register all built-in tool renderers
registerToolRenderer("bash", new BashRenderer());
registerToolRenderer("read", new ReadRenderer());
registerToolRenderer("write", new WriteRenderer());
registerToolRenderer("edit", new EditRenderer());
registerToolRenderer("ls", new LsRenderer());
registerToolRenderer("find", new FindRenderer());
registerToolRenderer("grep", new GrepRenderer());

const defaultRenderer = new DefaultRenderer();

// Global flag to force default JSON rendering for all tools
let showJsonMode = false;

/**
 * Enable or disable show JSON mode
 * When enabled, all tool renderers will use the default JSON renderer
 */
export function setShowJsonMode(enabled: boolean): void {
	showJsonMode = enabled;
}

/**
 * Render tool - unified function that handles params, result, and streaming state
 */
export function renderTool(
	toolName: string,
	params: any | undefined,
	result: ToolResultMessage | undefined,
	isStreaming?: boolean,
): ToolRenderResult {
	// If showJsonMode is enabled, always use the default renderer
	if (showJsonMode) {
		return defaultRenderer.render(params, result, isStreaming);
	}

	const renderer = getToolRenderer(toolName);
	if (renderer) {
		return renderer.render(params, result, isStreaming);
	}
	return defaultRenderer.withToolName(toolName).render(params, result, isStreaming);
}

export { getToolRenderer, registerToolRenderer };
