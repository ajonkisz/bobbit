import { RoleStore, type Role } from "./role-store.js";

/** Valid role name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Known agent tools — used by the UI tool selector */
const AVAILABLE_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"web_search",
	"web_fetch",
	"delegate",
	"team_list",
	"task_list",
	"task_create",
	"task_update",
	"artifact_list",
	"artifact_create",
	"artifact_get",
	"artifact_update",
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

		// Validate name
		if (!name || typeof name !== "string") {
			throw new Error("Missing role name");
		}
		if (!NAME_PATTERN.test(name)) {
			throw new Error("Role name must be lowercase alphanumeric + hyphens (e.g. 'my-role')");
		}
		if (this.store.get(name)) {
			throw new Error(`Role "${name}" already exists`);
		}

		// Validate label
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
	getAvailableTools(): string[] {
		return [...AVAILABLE_TOOLS];
	}
}
