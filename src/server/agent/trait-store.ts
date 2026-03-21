import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";

export interface Trait {
	/** Unique identifier — lowercase alphanumeric + hyphens */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Short tooltip for UI (one line) */
	description: string;
	/** 1-2 sentences injected into system prompt */
	promptFragment: string;
	createdAt: number;
	updatedAt: number;
}

/** traits/ directory at the repo root — version controlled */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRAITS_DIR = path.resolve(__dirname, "../../../traits");

/**
 * File-backed trait store. Each trait is a YAML file in traits/<name>.yaml
 * at the repo root. Version controlled — edits via the UI write back
 * to the same files so they can be committed.
 */
export class TraitStore {
	private traits: Map<string, Trait> = new Map();

	constructor() {
		fs.mkdirSync(TRAITS_DIR, { recursive: true });
		this.loadAll();
	}

	private traitFilePath(name: string): string {
		const filePath = path.join(TRAITS_DIR, `${name}.yaml`);
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(TRAITS_DIR))) {
			throw new Error(`Invalid trait name: path traversal detected`);
		}
		return filePath;
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(TRAITS_DIR, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(TRAITS_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.name) {
					this.traits.set(data.name, {
						name: data.name,
						label: data.label ?? data.name,
						description: data.description ?? "",
						promptFragment: data.promptFragment ?? "",
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					});
				}
			} catch (err) {
				console.error(`[trait-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private saveOne(trait: Trait): void {
		const filePath = this.traitFilePath(trait.name);
		try {
			const content = stringify({
				name: trait.name,
				label: trait.label,
				description: trait.description,
				promptFragment: trait.promptFragment,
				createdAt: trait.createdAt,
				updatedAt: trait.updatedAt,
			}, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[trait-store] Failed to save ${filePath}:`, err);
		}
	}

	put(trait: Trait): void {
		this.traits.set(trait.name, trait);
		this.saveOne(trait);
	}

	get(name: string): Trait | undefined {
		return this.traits.get(name);
	}

	remove(name: string): void {
		this.traits.delete(name);
		const filePath = this.traitFilePath(name);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.traits.clear();
		this.loadAll();
	}

	getAll(): Trait[] {
		this.reload();
		return Array.from(this.traits.values());
	}

	update(name: string, updates: Partial<Omit<Trait, "name" | "createdAt">>): boolean {
		const existing = this.traits.get(name);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}
