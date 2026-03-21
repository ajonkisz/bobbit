import { WorkflowStore, type Workflow, type WorkflowArtifact } from "./workflow-store.js";

/** Valid workflow ID pattern: lowercase alphanumeric + hyphens */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

const VALID_KINDS = new Set(["analysis", "deliverable", "review", "verification"]);
const VALID_FORMATS = new Set(["markdown", "html", "diff", "command"]);

export class WorkflowManager {
	/** Exposed for passing to createGoal for workflow snapshotting */
	public readonly store: WorkflowStore;

	constructor(store: WorkflowStore) {
		this.store = store;
	}

	createWorkflow(opts: {
		id: string;
		name: string;
		description?: string;
		artifacts: WorkflowArtifact[];
	}): Workflow {
		const { id, name, artifacts } = opts;

		if (!id || typeof id !== "string") {
			throw new Error("Missing workflow id");
		}
		if (!ID_PATTERN.test(id)) {
			throw new Error("Workflow id must be lowercase alphanumeric + hyphens (e.g. 'my-workflow')");
		}
		if (this.store.get(id)) {
			throw new Error(`Workflow "${id}" already exists`);
		}
		if (!name || typeof name !== "string") {
			throw new Error("Missing workflow name");
		}

		this.validateArtifacts(artifacts);

		const now = Date.now();
		const workflow: Workflow = {
			id,
			name,
			description: opts.description || "",
			artifacts,
			createdAt: now,
			updatedAt: now,
		};
		this.store.put(workflow);
		return workflow;
	}

	getWorkflow(id: string): Workflow | undefined {
		return this.store.get(id);
	}

	listWorkflows(): Workflow[] {
		return this.store.getAll();
	}

	updateWorkflow(id: string, updates: {
		name?: string;
		description?: string;
		artifacts?: WorkflowArtifact[];
	}): boolean {
		const existing = this.store.get(id);
		if (!existing) return false;

		// If artifacts are being updated, validate the new DAG
		if (updates.artifacts) {
			this.validateArtifacts(updates.artifacts);
		}

		const cleaned: Partial<Omit<Workflow, "id" | "createdAt">> = {};
		if (updates.name !== undefined) cleaned.name = updates.name;
		if (updates.description !== undefined) cleaned.description = updates.description;
		if (updates.artifacts !== undefined) cleaned.artifacts = updates.artifacts;
		return this.store.update(id, cleaned);
	}

	deleteWorkflow(id: string): boolean {
		const workflow = this.store.get(id);
		if (!workflow) return false;
		this.store.remove(id);
		return true;
	}

	cloneWorkflow(id: string): Workflow {
		const original = this.store.get(id);
		if (!original) {
			throw new Error(`Workflow "${id}" not found`);
		}

		// Deep copy via JSON round-trip
		const cloned: Workflow = JSON.parse(JSON.stringify(original));

		// Generate new ID: original-clone-<timestamp>, truncated to keep reasonable length
		const suffix = `-clone-${Date.now()}`;
		const maxBaseLen = 60 - suffix.length;
		const base = id.length > maxBaseLen ? id.slice(0, maxBaseLen) : id;
		cloned.id = base + suffix;

		const now = Date.now();
		cloned.createdAt = now;
		cloned.updatedAt = now;

		this.store.put(cloned);
		return cloned;
	}

	/**
	 * Validate workflow artifacts:
	 * 1. At least one artifact required
	 * 2. Unique IDs within the workflow
	 * 3. All dependsOn references exist within the workflow
	 * 4. No self-references
	 * 5. No circular dependencies (topological sort)
	 * 6. Valid kind and format values
	 */
	private validateArtifacts(artifacts: WorkflowArtifact[]): void {
		if (!Array.isArray(artifacts) || artifacts.length === 0) {
			throw new Error("Workflow must have at least one artifact");
		}

		// Check unique IDs and validate format
		const ids = new Set<string>();
		for (const artifact of artifacts) {
			if (!artifact.id || typeof artifact.id !== "string") {
				throw new Error("Each artifact must have an id");
			}
			if (!ID_PATTERN.test(artifact.id)) {
				throw new Error(`Artifact ID "${artifact.id}" must be lowercase alphanumeric + hyphens (e.g. 'issue-analysis')`);
			}
			if (ids.has(artifact.id)) {
				throw new Error(`Duplicate artifact ID: "${artifact.id}"`);
			}
			ids.add(artifact.id);
		}

		// Validate each artifact
		for (const artifact of artifacts) {
			if (!artifact.name || typeof artifact.name !== "string") {
				throw new Error(`Artifact "${artifact.id}" must have a name`);
			}
			if (artifact.kind && !VALID_KINDS.has(artifact.kind)) {
				throw new Error(`Artifact "${artifact.id}" has invalid kind: ${artifact.kind}. Must be one of: analysis, deliverable, review, verification`);
			}
			if (artifact.format && !VALID_FORMATS.has(artifact.format)) {
				throw new Error(`Artifact "${artifact.id}" has invalid format: ${artifact.format}. Must be one of: markdown, html, diff, command`);
			}

			// Check dependsOn references
			if (Array.isArray(artifact.dependsOn)) {
				for (const dep of artifact.dependsOn) {
					if (dep === artifact.id) {
						throw new Error(`Artifact "${artifact.id}" depends on itself`);
					}
					if (!ids.has(dep)) {
						throw new Error(`Artifact "${artifact.id}" depends on unknown "${dep}"`);
					}
				}
			}
		}

		// Check for circular dependencies via topological sort
		const artifactMap = new Map(artifacts.map(a => [a.id, a]));
		const visited = new Set<string>();
		const visiting = new Set<string>();

		const visit = (id: string): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				throw new Error(`Circular dependency detected involving "${id}"`);
			}
			visiting.add(id);
			const artifact = artifactMap.get(id)!;
			if (Array.isArray(artifact.dependsOn)) {
				for (const dep of artifact.dependsOn) {
					visit(dep);
				}
			}
			visiting.delete(id);
			visited.add(id);
		};

		for (const artifact of artifacts) {
			visit(artifact.id);
		}
	}
}
