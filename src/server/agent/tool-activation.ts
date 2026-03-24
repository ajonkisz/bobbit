/**
 * Maps role allowedTools to pi-coding-agent CLI flags.
 *
 * Tools come from three sources (defined in tools/*.yaml `provider` field):
 * 1. **Builtin tools** (pi-coding-agent built-in): read, bash, edit, write, grep, find, ls
 *    → Controlled via `--tools` flag
 * 2. **User extensions** (.bobbit/extensions/): delegate, web_search, web_fetch, browser_*, workflow
 *    → Controlled via `--no-extensions` + selective `--extension` flags
 * 3. **Bobbit extensions** (extensions/): task_*, gate_*, team_*
 *    → Controlled via `--extension` flag (added separately by session-manager)
 *
 * Provider info is read from tools/*.yaml via ToolManager instead of hardcoded maps.
 * All sessions use `--no-extensions` so Bobbit has complete control over extension loading.
 */

import path from "node:path";
import { bobbitDir } from "../bobbit-dir.js";
import type { ToolManager } from "./tool-manager.js";

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Given a role's allowedTools list and a ToolManager, compute the CLI args needed
 * to activate exactly those tools (plus Bobbit extensions which are handled separately).
 *
 * If allowedTools is empty or undefined, all tools are enabled (all builtins + all user extensions).
 * Always adds `--no-extensions` so Bobbit has complete control over extension loading.
 */
export function computeToolActivationArgs(allowedTools?: string[], toolManager?: ToolManager): ToolActivationResult {
	const args: string[] = [];

	if (!toolManager) {
		// Fallback: no tool manager available, can't resolve providers.
		// Enable all base tools and disable extension auto-discovery for safety.
		console.warn("[tool-activation] No ToolManager provided — using fallback (all base tools, no extensions)");
		args.push("--tools", "read,bash,edit,write,grep,find,ls");
		args.push("--no-extensions");
		return { args };
	}

	const extDir = path.join(bobbitDir(), "extensions");

	// Load all providers in a single YAML scan
	const providers = toolManager.getToolProviders();

	// No restrictions — enable all builtins and all user extensions
	if (!allowedTools || allowedTools.length === 0) {
		const builtins: string[] = [];
		const extensionPaths = new Set<string>();

		for (const [, provider] of providers) {
			if (provider.type === "builtin" && provider.tool) {
				// Skip bash — provided by custom bash-tool.ts extension (loaded by rpc-bridge)
				if (provider.tool === "bash") continue;
				builtins.push(provider.tool);
			} else if (provider.type === "user-extension" && provider.extension) {
				extensionPaths.add(path.join(extDir, provider.extension));
			}
			// bobbit-extension: skip, handled by session-manager
		}

		if (builtins.length > 0) {
			args.push("--tools", builtins.join(","));
		}
		args.push("--no-extensions");
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
		return { args };
	}

	// Restricted set — resolve each allowed tool via its provider
	const activeBaseTools: string[] = [];
	const neededExtensions = new Set<string>();

	for (const toolName of allowedTools) {
		const provider = providers.get(toolName);
		if (!provider) {
			// Unknown tool — log warning and skip
			console.warn(`[tool-activation] Tool "${toolName}" has no provider in tools/*.yaml — skipping`);
			continue;
		}
		if (provider.type === "builtin" && provider.tool) {
			// Skip bash — provided by custom bash-tool.ts extension (loaded by rpc-bridge)
			if (provider.tool !== "bash") activeBaseTools.push(provider.tool);
		} else if (provider.type === "user-extension" && provider.extension) {
			neededExtensions.add(path.join(extDir, provider.extension));
		}
		// bobbit-extension: skip, handled by session-manager
	}

	if (activeBaseTools.length > 0) {
		args.push("--tools", activeBaseTools.join(","));
	} else {
		args.push("--no-tools");
	}

	// Always use --no-extensions so Bobbit controls all extension loading
	args.push("--no-extensions");
	for (const extPath of neededExtensions) {
		args.push("--extension", extPath);
	}

	return { args };
}
