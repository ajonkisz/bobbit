import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";

export type ArtifactKind = "analysis" | "deliverable" | "review" | "verification";
export type ArtifactFormat = "markdown" | "html" | "diff" | "command";

export interface VerificationStep {
	name: string;
	type: "command" | "llm-review";
	command?: string;
	prompt?: string;
	accept_when?: string;
	timeout: number;
}

export interface VerificationConfig {
	type: "command" | "llm-review" | "combined";
	prompt?: string;
	command?: string;
	accept_when?: string;
	timeout?: number;
	steps?: VerificationStep[];
}

export interface WorkflowArtifact {
	id: string;
	name: string;
	description: string;
	kind: ArtifactKind;
	format: ArtifactFormat;
	dependsOn: string[];
	mustHave: string[];
	shouldHave: string[];
	mustNotHave: string[];
	suggestedRole?: string;
	verification?: VerificationConfig;
}

export interface Workflow {
	id: string;
	name: string;
	description: string;
	artifacts: WorkflowArtifact[];
	createdAt: number;
	updatedAt: number;
}

/** workflows/ directory at the repo root — version controlled */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(__dirname, "../../../workflows");

/**
 * File-backed workflow store. Each workflow is a YAML file in
 * workflows/<id>.yaml at the repo root. Version controlled —
 * edits via the UI write back to the same files so they can be committed.
 */
export class WorkflowStore {
	private workflows: Map<string, Workflow> = new Map();

	constructor() {
		fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
		this.loadAll();
		// Seed defaults if directory is empty
		if (this.workflows.size === 0) {
			this.seedDefaults();
		}
	}

	private workflowFilePath(id: string): string {
		const filePath = path.join(WORKFLOWS_DIR, `${id}.yaml`);
		const resolved = path.resolve(filePath);
		if (!resolved.startsWith(path.resolve(WORKFLOWS_DIR))) {
			throw new Error(`Invalid workflow id: path traversal detected`);
		}
		return filePath;
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(WORKFLOWS_DIR, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(WORKFLOWS_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.id) {
					this.workflows.set(data.id, this.normalizeWorkflow(data));
				}
			} catch (err) {
				console.error(`[workflow-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private normalizeWorkflow(data: Record<string, unknown>): Workflow {
		const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
		return {
			id: data.id as string,
			name: (data.name as string) ?? (data.id as string),
			description: (data.description as string) ?? "",
			artifacts: artifacts.map((a: Record<string, unknown>) => this.normalizeArtifact(a)),
			createdAt: (data.createdAt as number) ?? 0,
			updatedAt: (data.updatedAt as number) ?? 0,
		};
	}

	private normalizeArtifact(data: Record<string, unknown>): WorkflowArtifact {
		const artifact: WorkflowArtifact = {
			id: (data.id as string) ?? "",
			name: (data.name as string) ?? "",
			description: (data.description as string) ?? "",
			kind: (data.kind as ArtifactKind) ?? "analysis",
			format: (data.format as ArtifactFormat) ?? "markdown",
			dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn : [],
			mustHave: Array.isArray(data.mustHave) ? data.mustHave : [],
			shouldHave: Array.isArray(data.shouldHave) ? data.shouldHave : [],
			mustNotHave: Array.isArray(data.mustNotHave) ? data.mustNotHave : [],
		};
		if (data.suggestedRole) artifact.suggestedRole = data.suggestedRole as string;
		if (data.verification) artifact.verification = data.verification as VerificationConfig;
		return artifact;
	}

	private saveOne(workflow: Workflow): void {
		const filePath = this.workflowFilePath(workflow.id);
		try {
			const obj: Record<string, unknown> = {
				id: workflow.id,
				name: workflow.name,
				description: workflow.description,
				artifacts: workflow.artifacts.map((a) => {
					const out: Record<string, unknown> = {
						id: a.id,
						name: a.name,
						description: a.description,
						kind: a.kind,
						format: a.format,
						dependsOn: a.dependsOn,
						mustHave: a.mustHave,
						shouldHave: a.shouldHave,
						mustNotHave: a.mustNotHave,
					};
					if (a.suggestedRole) out.suggestedRole = a.suggestedRole;
					if (a.verification) out.verification = a.verification;
					return out;
				}),
				createdAt: workflow.createdAt,
				updatedAt: workflow.updatedAt,
			};
			const content = stringify(obj, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[workflow-store] Failed to save ${filePath}:`, err);
		}
	}

	private seedDefaults(): void {
		// Seed workflows are committed as YAML files in the repo (e.g. workflows/bug-fix.yaml).
		// If they exist on disk but weren't loaded yet (e.g. first run), reload from disk.
		// We no longer maintain a programmatic duplicate of the seed content.
		const bugFixPath = path.join(WORKFLOWS_DIR, "bug-fix.yaml");
		if (fs.existsSync(bugFixPath)) {
			this.loadAll();
		} else {
			console.warn("[workflow-store] No seed workflows found in workflows/ directory. Expected bug-fix.yaml to be committed to the repo.");
		}
	}

	put(workflow: Workflow): void {
		this.workflows.set(workflow.id, workflow);
		this.saveOne(workflow);
	}

	get(id: string): Workflow | undefined {
		return this.workflows.get(id);
	}

	remove(id: string): void {
		this.workflows.delete(id);
		const filePath = this.workflowFilePath(id);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.workflows.clear();
		this.loadAll();
	}

	getAll(): Workflow[] {
		this.reload();
		return Array.from(this.workflows.values());
	}

	update(id: string, updates: Partial<Omit<Workflow, "id" | "createdAt">>): boolean {
		const existing = this.workflows.get(id);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined && k !== "id" && k !== "createdAt") cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.saveOne(existing);
		return true;
	}
}
