import fs from "node:fs";
import path from "node:path";
import { piDir } from "../pi-dir.js";

export interface ToolMetadata {
	name: string;
	description?: string;
	group?: string;
	docs?: string;
	updatedAt: number;
}

const DEFAULT_PATH = path.join(piDir(), "gateway-tools.json");

/**
 * File-backed tool metadata store. Persists custom overrides
 * (description, group, docs) to ~/.pi/gateway-tools.json.
 * Same load-on-construct, write-on-mutate pattern as other stores.
 */
export class ToolStore {
	private tools: Map<string, ToolMetadata> = new Map();
	/** Default allowed tools for sessions without a role. null = all tools allowed. */
	private _defaultAllowedTools: string[] | null = null;
	private filePath: string;

	constructor(filePath?: string) {
		this.filePath = filePath ?? DEFAULT_PATH;
		this.load();
	}

	private load(): void {
		try {
			const raw = fs.readFileSync(this.filePath, "utf-8");
			const data = JSON.parse(raw);
			if (Array.isArray(data)) {
				// Legacy format: array of tool metadata
				for (const item of data) {
					if (item && typeof item === "object" && item.name) {
						this.tools.set(item.name, item);
					}
				}
			} else if (data && typeof data === "object") {
				// New format: { tools: [...], defaultAllowedTools: [...] | null }
				if (Array.isArray(data.tools)) {
					for (const item of data.tools) {
						if (item && typeof item === "object" && item.name) {
							this.tools.set(item.name, item);
						}
					}
				}
				if (data.defaultAllowedTools !== undefined) {
					this._defaultAllowedTools = Array.isArray(data.defaultAllowedTools) ? data.defaultAllowedTools : null;
				}
			}
		} catch {
			// File doesn't exist or is invalid — start empty
		}
	}

	private save(): void {
		const dir = path.dirname(this.filePath);
		fs.mkdirSync(dir, { recursive: true });
		const data = {
			tools: Array.from(this.tools.values()),
			defaultAllowedTools: this._defaultAllowedTools,
		};
		fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
	}

	get(name: string): ToolMetadata | undefined {
		return this.tools.get(name);
	}

	put(meta: ToolMetadata): void {
		this.tools.set(meta.name, meta);
		this.save();
	}

	getAll(): ToolMetadata[] {
		return Array.from(this.tools.values());
	}

	/** Get the default allowed tools list. null means all tools are allowed. */
	getDefaultAllowedTools(): string[] | null {
		return this._defaultAllowedTools;
	}

	/** Set the default allowed tools. null = all allowed, empty array = none allowed. */
	setDefaultAllowedTools(tools: string[] | null): void {
		this._defaultAllowedTools = tools;
		this.save();
	}
}
