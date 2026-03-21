import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ToolStore } from "./tool-store.js";

export interface ToolProvider {
	type: 'builtin' | 'user-extension' | 'bobbit-extension';
	tool?: string;       // for builtin
	extension?: string;  // for user-extension and bobbit-extension
}

/** Base tool definition loaded from YAML */
interface BaseToolInfo {
	name: string;
	description: string;
	summary?: string;
	group: string;
	renderer?: string;
	docs?: string;
	provider?: ToolProvider;
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
						summary: data.summary,
						group: data.group || "Other",
						renderer: data.renderer,
						docs: data.docs,
						provider: data.provider,
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
	 *
	 * Generates two sections:
	 * 1. **Tool Overview** — grouped by `group`, one-line `summary` per tool
	 * 2. **Tool Documentation** — grouped by `group`, full `docs` per tool
	 *
	 * If `toolNames` is provided, only includes those tools; otherwise includes all.
	 */
	getToolDocsForPrompt(toolNames?: string[]): string {
		const tools = loadToolDefinitions();

		// Build grouped data: group → [{ name, summary, docs }]
		const grouped = new Map<string, Array<{ name: string; summary: string; docs?: string }>>();

		for (const tool of tools) {
			if (toolNames && !toolNames.includes(tool.name)) continue;
			const override = this.store.get(tool.name);
			const group = override?.group ?? tool.group;
			const summary = tool.summary ?? override?.description ?? tool.description;
			const docs = override?.docs ?? tool.docs;

			if (!grouped.has(group)) grouped.set(group, []);
			grouped.get(group)!.push({
				name: tool.name,
				summary,
				docs: docs?.trim(),
			});
		}

		if (grouped.size === 0) return "";

		// Part 1: Tool Overview
		const sections: string[] = ["# Tools"];
		for (const [group, entries] of grouped) {
			sections.push(`\n## ${group}\n`);
			for (const entry of entries) {
				sections.push(`- **${entry.name}**: ${entry.summary}`);
			}
		}

		// Part 2: Tool Documentation (only tools that have docs)
		const docSections: string[] = [];
		for (const [group, entries] of grouped) {
			const withDocs = entries.filter((e) => e.docs);
			if (withDocs.length === 0) continue;
			docSections.push(`\n## ${group}\n`);
			for (const entry of withDocs) {
				docSections.push(`### ${entry.name}\n\n${entry.docs}\n`);
			}
		}

		if (docSections.length > 0) {
			sections.push("\n# Tool Documentation");
			sections.push(...docSections);
		}

		return sections.join("\n");
	}

	/** Returns the provider info for a tool, or undefined if not found. */
	getToolProvider(name: string): ToolProvider | undefined {
		const tools = loadToolDefinitions();
		const base = tools.find((t) => t.name === name);
		return base?.provider;
	}

	/** Returns all tool providers in a single YAML scan (avoids repeated disk reads). */
	getToolProviders(): Map<string, ToolProvider> {
		const tools = loadToolDefinitions();
		const map = new Map<string, ToolProvider>();
		for (const tool of tools) {
			if (tool.provider) map.set(tool.name, tool.provider);
		}
		return map;
	}

	/** Returns all tool names from YAML definitions. */
	getAllToolNames(): string[] {
		return loadToolDefinitions().map((t) => t.name);
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

	/** Get the default allowed tools for sessions without a role. null = all tools. */
	getDefaultAllowedTools(): string[] | null {
		return this.store.getDefaultAllowedTools();
	}

	/** Set the default allowed tools. null = all tools allowed. */
	setDefaultAllowedTools(tools: string[] | null): void {
		this.store.setDefaultAllowedTools(tools);
	}
}
