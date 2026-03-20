import { RoleStore, type Role } from "./role-store.js";
import type { ToolStore } from "./tool-store.js";
import { generateRoleNames } from "./name-generator.js";

/** Valid role name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Base tool definition (internal, without renderer/docs metadata) */
interface BaseToolInfo {
	name: string;
	description: string;
	group: string;
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	hasRenderer: boolean;
	rendererFile?: string;
}

/** Static map of tool name → renderer file path, derived from src/ui/tools/index.ts registrations */
const RENDERER_MAP: Record<string, string> = {
	bash: "src/ui/tools/renderers/BashRenderer.ts",
	read: "src/ui/tools/renderers/ReadRenderer.ts",
	write: "src/ui/tools/renderers/WriteRenderer.ts",
	edit: "src/ui/tools/renderers/EditRenderer.ts",
	ls: "src/ui/tools/renderers/LsRenderer.ts",
	find: "src/ui/tools/renderers/FindRenderer.ts",
	grep: "src/ui/tools/renderers/GrepRenderer.ts",
	browser_screenshot: "src/ui/tools/renderers/ScreenshotRenderer.ts",
	browser_navigate: "src/ui/tools/renderers/BrowserNavigateRenderer.ts",
	browser_click: "src/ui/tools/renderers/BrowserClickRenderer.ts",
	browser_type: "src/ui/tools/renderers/BrowserTypeRenderer.ts",
	browser_eval: "src/ui/tools/renderers/BrowserEvalRenderer.ts",
	browser_wait: "src/ui/tools/renderers/BrowserWaitRenderer.ts",
	web_search: "src/ui/tools/renderers/WebSearchRenderer.ts",
	web_fetch: "src/ui/tools/renderers/WebFetchRenderer.ts",
	delegate: "src/ui/tools/renderers/DelegateRenderer.ts",
	team_spawn: "src/ui/tools/renderers/TeamToolRenderers.ts",
	team_list: "src/ui/tools/renderers/TeamToolRenderers.ts",
	team_dismiss: "src/ui/tools/renderers/TeamToolRenderers.ts",
	team_complete: "src/ui/tools/renderers/TeamToolRenderers.ts",
	task_list: "src/ui/tools/renderers/TaskToolRenderers.ts",
	task_create: "src/ui/tools/renderers/TaskToolRenderers.ts",
	task_update: "src/ui/tools/renderers/TaskToolRenderers.ts",
	artifact_list: "src/ui/tools/renderers/ArtifactToolRenderers.ts",
	artifact_create: "src/ui/tools/renderers/ArtifactToolRenderers.ts",
	artifact_get: "src/ui/tools/renderers/ArtifactToolRenderers.ts",
	artifact_update: "src/ui/tools/renderers/ArtifactToolRenderers.ts",
};

/** All known agent tools with descriptions and groupings */
const AVAILABLE_TOOLS: BaseToolInfo[] = [
	// File system
	{ name: "read", description: "Read file contents (text or images)", group: "File System" },
	{ name: "write", description: "Create or overwrite a file", group: "File System" },
	{ name: "edit", description: "Replace exact text in a file", group: "File System" },

	// Shell
	{ name: "bash", description: "Execute shell commands", group: "Shell" },

	// Web
	{ name: "web_search", description: "Search the web via DuckDuckGo", group: "Web" },
	{ name: "web_fetch", description: "Fetch a URL and extract text", group: "Web" },

	// Browser
	{ name: "browser_navigate", description: "Navigate to a URL in headless browser", group: "Browser" },
	{ name: "browser_screenshot", description: "Take a screenshot of the page", group: "Browser" },
	{ name: "browser_click", description: "Click an element by CSS selector", group: "Browser" },
	{ name: "browser_type", description: "Type text into an input element", group: "Browser" },
	{ name: "browser_eval", description: "Execute JavaScript in the page", group: "Browser" },
	{ name: "browser_wait", description: "Wait for an element to appear", group: "Browser" },

	// Agent
	{ name: "delegate", description: "Run a task in a separate agent process", group: "Agent" },

	// Team coordination
	{ name: "team_spawn", description: "Spawn a role agent with its own worktree", group: "Team" },
	{ name: "team_list", description: "List all agents in the team", group: "Team" },
	{ name: "team_dismiss", description: "Terminate an agent and clean up", group: "Team" },
	{ name: "team_complete", description: "Dismiss all agents and complete goal", group: "Team" },

	// Task management
	{ name: "task_list", description: "List all tasks for the goal", group: "Tasks" },
	{ name: "task_create", description: "Create a new task with type and dependencies", group: "Tasks" },
	{ name: "task_update", description: "Update task fields, assignment, or state", group: "Tasks" },

	// Artifact management
	{ name: "artifact_list", description: "List all goal artifacts", group: "Artifacts" },
	{ name: "artifact_create", description: "Create a goal artifact (design doc, findings, etc.)", group: "Artifacts" },
	{ name: "artifact_get", description: "Get an artifact's full content", group: "Artifacts" },
	{ name: "artifact_update", description: "Update an artifact's content", group: "Artifacts" },
];

export class RoleManager {
	private toolStore?: ToolStore;

	constructor(private store: RoleStore, toolStore?: ToolStore) {
		this.toolStore = toolStore;
	}

	createRole(opts: {
		name: string;
		label: string;
		promptTemplate: string;
		allowedTools?: string[];
		accessory?: string;
	}): Role {
		const { name, label, promptTemplate, allowedTools = [], accessory = "none" } = opts;

		if (!name || typeof name !== "string") {
			throw new Error("Missing role name");
		}
		if (!NAME_PATTERN.test(name)) {
			throw new Error("Role name must be lowercase alphanumeric + hyphens (e.g. 'my-role')");
		}
		if (this.store.get(name)) {
			throw new Error(`Role \"${name}\" already exists`);
		}

		if (!label || typeof label !== "string") {
			throw new Error("Missing role label");
		}

		const now = Date.now();
		const role: Role = {
			name,
			label,
			promptTemplate: promptTemplate || "",
			allowedTools,
			accessory,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(role);

		// Fire-and-forget: generate role-themed names via LLM
		generateRoleNames(name, label).catch((err) => {
			console.error(`[role-manager] Failed to generate names for role "${name}":`, err);
		});

		return role;
	}

	getRole(name: string): Role | undefined {
		return this.store.get(name);
	}

	listRoles(): Role[] {
		return this.store.getAll();
	}

	updateRole(name: string, updates: {
		label?: string;
		promptTemplate?: string;
		allowedTools?: string[];
		accessory?: string;
	}): boolean {
		return this.store.update(name, updates);
	}

	deleteRole(name: string): boolean {
		const role = this.store.get(name);
		if (!role) return false;
		this.store.remove(name);
		return true;
	}

	/** Returns the list of all known agent tools with renderer info and custom overrides */
	getAvailableTools(): ToolInfo[] {
		return AVAILABLE_TOOLS.map((tool) => {
			const override = this.toolStore?.get(tool.name);
			const rendererFile = RENDERER_MAP[tool.name];
			return {
				name: tool.name,
				description: override?.description ?? tool.description,
				group: override?.group ?? tool.group,
				docs: override?.docs,
				hasRenderer: !!rendererFile,
				rendererFile,
			};
		});
	}

	/** Returns a single tool's full detail, or undefined if not found */
	getToolByName(name: string): ToolInfo | undefined {
		const base = AVAILABLE_TOOLS.find((t) => t.name === name);
		if (!base) return undefined;
		const override = this.toolStore?.get(name);
		const rendererFile = RENDERER_MAP[name];
		return {
			name: base.name,
			description: override?.description ?? base.description,
			group: override?.group ?? base.group,
			docs: override?.docs,
			hasRenderer: !!rendererFile,
			rendererFile,
		};
	}

	/** Updates custom tool metadata (description, group, docs) */
	updateToolMetadata(name: string, updates: { description?: string; group?: string; docs?: string }): boolean {
		// Verify the tool exists in AVAILABLE_TOOLS
		const base = AVAILABLE_TOOLS.find((t) => t.name === name);
		if (!base) return false;
		if (!this.toolStore) return false;

		const existing = this.toolStore.get(name);
		const meta = {
			name,
			description: updates.description ?? existing?.description,
			group: updates.group ?? existing?.group,
			docs: updates.docs ?? existing?.docs,
			updatedAt: Date.now(),
		};
		this.toolStore.put(meta);
		return true;
	}
}
