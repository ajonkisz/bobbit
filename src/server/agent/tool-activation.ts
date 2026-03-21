/**
 * Maps role allowedTools to pi-coding-agent CLI flags.
 *
 * Tools come from three sources:
 * 1. **Base tools** (pi-coding-agent built-in): read, bash, edit, write, grep, find, ls
 *    → Controlled via `--tools` flag
 * 2. **User extensions** (~/.pi/extensions/): delegate, web_search, web_fetch, browser_*, workflow
 *    → Controlled via `--no-extensions` + selective `--extension` flags
 * 3. **Bobbit extensions** (extensions/): task_*, artifact_*, team_*
 *    → Controlled via `--extension` flag (added separately by session-manager)
 */

import path from "node:path";
import { piDir } from "../pi-dir.js";

/** All base tools built into pi-coding-agent */
const BASE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Map from tool name to the extension file that provides it */
const EXTENSION_TOOL_MAP: Record<string, string> = (() => {
	const extDir = path.join(piDir(), "extensions");
	const delegate = path.join(extDir, "delegate.ts");
	const webResearch = path.join(extDir, "web-research.ts");
	const playwright = path.join(extDir, "playwright", "index.ts");
	const workflow = path.join(extDir, "workflow.ts");

	return {
		delegate,
		web_search: webResearch,
		web_fetch: webResearch,
		browser_navigate: playwright,
		browser_screenshot: playwright,
		browser_click: playwright,
		browser_type: playwright,
		browser_eval: playwright,
		browser_wait: playwright,
		workflow,
	};
})();

/** Tools provided by Bobbit's own extensions (goal-tools.ts, team-lead-tools.ts) */
const BOBBIT_EXTENSION_TOOLS = new Set([
	"task_list", "task_create", "task_update",
	"artifact_list", "artifact_create", "artifact_get", "artifact_update",
	"team_spawn", "team_list", "team_dismiss", "team_complete",
	"team_steer", "team_abort", "team_prompt",
]);

/**
 * All known tool names across all sources.
 */
export const ALL_KNOWN_TOOLS = new Set([
	...BASE_TOOLS,
	...Object.keys(EXTENSION_TOOL_MAP),
	...BOBBIT_EXTENSION_TOOLS,
]);

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Given a role's allowedTools list, compute the CLI args needed to activate
 * exactly those tools (plus Bobbit extensions which are handled separately).
 *
 * If allowedTools is empty or undefined, all tools are enabled (no restrictions).
 */
export function computeToolActivationArgs(allowedTools?: string[]): ToolActivationResult {
	const args: string[] = [];

	// No restrictions — enable all base tools, let all extensions load normally
	if (!allowedTools || allowedTools.length === 0) {
		// Still explicitly enable all base tools (grep/find/ls aren't on by default)
		args.push("--tools", [...BASE_TOOLS].join(","));
		return { args };
	}

	// Compute which base tools to activate
	const activeBaseTools = allowedTools.filter(t => BASE_TOOLS.has(t));
	if (activeBaseTools.length > 0) {
		args.push("--tools", activeBaseTools.join(","));
	} else {
		args.push("--no-tools");
	}

	// Compute which user extensions to load
	const neededExtensions = new Set<string>();
	for (const tool of allowedTools) {
		const extPath = EXTENSION_TOOL_MAP[tool];
		if (extPath) {
			neededExtensions.add(extPath);
		}
	}

	// Check if ALL user extensions are needed
	const allExtensionPaths = new Set(Object.values(EXTENSION_TOOL_MAP));
	const allNeeded = [...allExtensionPaths].every(p => neededExtensions.has(p));

	if (allNeeded) {
		// All extensions needed — let auto-discovery handle it (no --no-extensions)
	} else {
		// Selective — disable auto-discovery and explicitly load needed ones
		args.push("--no-extensions");
		for (const extPath of neededExtensions) {
			args.push("--extension", extPath);
		}
	}

	return { args };
}
