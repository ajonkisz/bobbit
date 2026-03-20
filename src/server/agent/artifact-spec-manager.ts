import { ArtifactSpecStore, type ArtifactSpec } from "./artifact-spec-store.js";

/** Valid spec ID pattern: lowercase alphanumeric + hyphens */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const VALID_KINDS = new Set(["analysis", "deliverable", "review", "verification"]);
const VALID_FORMATS = new Set(["markdown", "html", "diff", "command"]);

export class ArtifactSpecManager {
	constructor(private store: ArtifactSpecStore) {}

	createSpec(opts: {
		id: string;
		name: string;
		description?: string;
		kind: string;
		format: string;
		mustHave?: string[];
		shouldHave?: string[];
		mustNotHave?: string[];
		requires?: string[];
		suggestedRole?: string;
	}): ArtifactSpec {
		const { id, name, kind, format } = opts;

		if (!id || typeof id !== "string") {
			throw new Error("Missing spec id");
		}
		if (!ID_PATTERN.test(id)) {
			throw new Error("Spec id must be lowercase alphanumeric + hyphens (e.g. 'my-spec')");
		}
		if (this.store.get(id)) {
			throw new Error(`Artifact spec "${id}" already exists`);
		}
		if (!name || typeof name !== "string") {
			throw new Error("Missing spec name");
		}
		if (!VALID_KINDS.has(kind)) {
			throw new Error(`Invalid kind: ${kind}. Must be one of: analysis, deliverable, review, verification`);
		}
		if (!VALID_FORMATS.has(format)) {
			throw new Error(`Invalid format: ${format}. Must be one of: markdown, html, diff, command`);
		}

		const now = Date.now();
		const spec: ArtifactSpec = {
			id,
			name,
			description: opts.description || "",
			kind: kind as ArtifactSpec["kind"],
			format: format as ArtifactSpec["format"],
			mustHave: opts.mustHave || [],
			shouldHave: opts.shouldHave || [],
			mustNotHave: opts.mustNotHave || [],
			requires: opts.requires?.length ? opts.requires : undefined,
			suggestedRole: opts.suggestedRole || undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(spec);
		return spec;
	}

	getSpec(id: string): ArtifactSpec | undefined {
		return this.store.get(id);
	}

	listSpecs(): ArtifactSpec[] {
		return this.store.getAll();
	}

	updateSpec(id: string, updates: {
		name?: string;
		description?: string;
		kind?: string;
		format?: string;
		mustHave?: string[];
		shouldHave?: string[];
		mustNotHave?: string[];
		requires?: string[];
		suggestedRole?: string;
	}): boolean {
		if (updates.kind && !VALID_KINDS.has(updates.kind)) {
			throw new Error(`Invalid kind: ${updates.kind}`);
		}
		if (updates.format && !VALID_FORMATS.has(updates.format)) {
			throw new Error(`Invalid format: ${updates.format}`);
		}
		// Cast validated kind/format to the proper types
		const cleaned: Partial<Omit<ArtifactSpec, "id" | "createdAt">> = {};
		if (updates.name !== undefined) cleaned.name = updates.name;
		if (updates.description !== undefined) cleaned.description = updates.description;
		if (updates.kind !== undefined) cleaned.kind = updates.kind as ArtifactSpec["kind"];
		if (updates.format !== undefined) cleaned.format = updates.format as ArtifactSpec["format"];
		if (updates.mustHave !== undefined) cleaned.mustHave = updates.mustHave;
		if (updates.shouldHave !== undefined) cleaned.shouldHave = updates.shouldHave;
		if (updates.mustNotHave !== undefined) cleaned.mustNotHave = updates.mustNotHave;
		if (updates.requires !== undefined) cleaned.requires = updates.requires;
		if (updates.suggestedRole !== undefined) cleaned.suggestedRole = updates.suggestedRole;
		return this.store.update(id, cleaned);
	}

	deleteSpec(id: string): boolean {
		const spec = this.store.get(id);
		if (!spec) return false;
		this.store.remove(id);
		return true;
	}
}
