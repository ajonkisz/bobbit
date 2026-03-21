import { TraitStore, type Trait } from "./trait-store.js";

/** Valid trait name pattern: lowercase alphanumeric + hyphens */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export class TraitManager {
	constructor(private store: TraitStore) {
	}

	createTrait(opts: {
		name: string;
		label: string;
		description: string;
		promptFragment: string;
	}): Trait {
		const { name, label, description, promptFragment } = opts;

		if (!name || typeof name !== "string") {
			throw new Error("Missing trait name");
		}
		if (!NAME_PATTERN.test(name)) {
			throw new Error("Trait name must be lowercase alphanumeric + hyphens (e.g. 'my-trait')");
		}
		if (this.store.get(name)) {
			throw new Error(`Trait "${name}" already exists`);
		}

		if (!label || typeof label !== "string") {
			throw new Error("Missing trait label");
		}

		const now = Date.now();
		const trait: Trait = {
			name,
			label,
			description: description || "",
			promptFragment: promptFragment || "",
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(trait);
		return trait;
	}

	getTrait(name: string): Trait | undefined {
		return this.store.get(name);
	}

	listTraits(): Trait[] {
		return this.store.getAll();
	}

	updateTrait(name: string, updates: {
		label?: string;
		description?: string;
		promptFragment?: string;
	}): boolean {
		return this.store.update(name, updates);
	}

	deleteTrait(name: string): boolean {
		const trait = this.store.get(name);
		if (!trait) return false;
		this.store.remove(name);
		return true;
	}

	/**
	 * Resolve trait names to their definitions.
	 * Returns only traits that exist, silently skipping unknown names.
	 */
	resolveTraits(names: string[]): Array<{ label: string; promptFragment: string }> {
		const result: Array<{ label: string; promptFragment: string }> = [];
		for (const name of names) {
			const trait = this.store.get(name);
			if (trait) {
				result.push({ label: trait.label, promptFragment: trait.promptFragment });
			}
		}
		return result;
	}
}
