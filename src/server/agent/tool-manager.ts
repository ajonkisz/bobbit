import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ToolStore } from "./tool-store.js";

/** Base tool definition loaded from YAML */
interface BaseToolInfo {
	name: string;
	description: string;
	group: string;
	renderer?: string;
	docs?: string;
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	hasRenderer: boolean;
	rendererFile?: string;
}

/** tools/ directory at the repo root — version controlled */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, "../../../tools");

/**
 * Scan the tools/ YAML directory and return all tool definitions.
 * Called on every request so new/edited YAML files are picked up without restart.
 */
function loadToolDefinitions(): BaseToolInfo[] {
	const tools: BaseToolInfo[] = [];
	try {
		const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			try {
				const raw = fs.readFileSync(path.join(TOOLS_DIR, entry.name), "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					tools.push({
						name: data.name,
						description: data.description || "",
						group: data.group || "Other",
						renderer: data.renderer,
						docs: data.docs,
					});
				}
			} catch (err) {
				console.error(`[tool-manager] Failed to load tool ${entry.name}:`, err);
			}
		}
	} catch {
		// Directory doesn't exist — return empty
	}
	return tools;
}

/**
 * Manages tool definitions and metadata.
 * Tool definitions are loaded from tools/*.yaml on every read.
 * Custom overrides (description, group, docs) are persisted via ToolStore.
 */
export class ToolManager {
	private store: ToolStore;

	constructor(store?: ToolStore) {
		this.store = store ?? new ToolStore();
	}

	/** Returns all tools, re-scanning the YAML directory on every call. */
	getAvailableTools(): ToolInfo[] {
		const tools = loadToolDefinitions();
		return tools.map((tool) => {
			const override = this.store.get(tool.name);
			return {
				name: tool.name,
				description: override?.description ?? tool.description,
				group: override?.group ?? tool.group,
				docs: override?.docs,
				hasRenderer: !!tool.renderer,
				rendererFile: tool.renderer,
			};
		});
	}

	/** Returns a single tool's full detail, or undefined if not found. */
	getToolByName(name: string): ToolInfo | undefined {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		if (!base) return undefined;
		const override = this.store.get(name);
		return {
			name: base.name,
			description: override?.description ?? base.description,
			group: override?.group ?? base.group,
			docs: override?.docs,
			hasRenderer: !!base.renderer,
			rendererFile: base.renderer,
		};
	}

	/**
	 * Returns formatted tool documentation for inclusion in system prompts.
	 * Groups tools by category and includes docs for any tool that has them.
	 * If `toolNames` is provided, only includes those tools; otherwise includes all.
	 */
	getToolDocsForPrompt(toolNames?: string[]): string {
		const tools = loadToolDefinitions();
		const grouped = new Map<string, Array<{ name: string; description: string; docs: string }>>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const override = this.store.get(tool.name);
			const docs = override?.docs ?? tool.docs;
			if (!docs) continue;

			const group = override?.group ?? tool.group;
			if (!grouped.has(group)) grouped.set(group, []);
			grouped.get(group)!.push({
				name: tool.name,
				description: override?.description ?? tool.description,
				docs: docs.trim(),
			});
		}

		if (grouped.size === 0) return "";

		const sections: string[] = ["# Tool Documentation"];
		for (const [group, entries] of grouped) {
			sections.push(`\n## ${group}\n`);
			for (const entry of entries) {
				sections.push(`### ${entry.name}\n\n${entry.docs}\n`);
			}
		}

		return sections.join("\n");
	}

	/** Updates custom tool metadata (description, group, docs). */
	updateToolMetadata(name: string, updates: { description?: string; group?: string; docs?: string }): boolean {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		if (!base) return false;

		const existing = this.store.get(name);
		const meta = {
			name,
			description: updates.description ?? existing?.description,
			group: updates.group ?? existing?.group,
			docs: updates.docs ?? existing?.docs,
			updatedAt: Date.now(),
		};
		this.store.put(meta);
		return true;
	}
}
