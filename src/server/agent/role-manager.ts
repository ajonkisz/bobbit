import { RoleStore, type Role } from "./role-store.js";

/** Valid role name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
}

/** All known agent tools with descriptions and groupings */
const AVAILABLE_TOOLS: ToolInfo[] = [
	// File system
	{ name: "Read", description: "Read file contents (text or images)", group: "File System" },
	{ name: "Write", description: "Create or overwrite a file", group: "File System" },
	{ name: "Edit", description: "Replace exact text in a file", group: "File System" },

	// Shell
	{ name: "Bash", description: "Execute shell commands", group: "Shell" },

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
	constructor(private store: RoleStore) {}

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

	/** Returns the list of all known agent tools for the UI tool selector */
	getAvailableTools(): ToolInfo[] {
		return [...AVAILABLE_TOOLS];
	}
}
