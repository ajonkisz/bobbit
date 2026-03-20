import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";

export type ArtifactKind = "analysis" | "deliverable" | "review" | "verification";
export type ArtifactFormat = "markdown" | "html" | "diff" | "command";

export interface ArtifactSpec {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	id: string;
	/** Human-readable display label */
	name: string;
	/** What this artifact is and why it matters */
	description: string;
	/** Nature of the work */
	kind: ArtifactKind;
	/** Output format the agent produces */
	format: ArtifactFormat;
	/** Non-negotiable requirements */
	mustHave: string[];
	/** Strongly recommended */
	shouldHave: string[];
	/** Disqualifying traits */
	mustNotHave: string[];
	/** Other artifact spec IDs that must have artifacts first */
	requires?: string[];
	/** Role best suited to produce this */
	suggestedRole?: string;
	createdAt: number;
	updatedAt: number;
}

/** artifact-specs/ directory at the repo root — version controlled */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = path.resolve(__dirname, "../../../artifact-specs");

/**
 * File-backed artifact spec store. Each spec is a YAML file in
 * artifact-specs/<id>.yaml at the repo root. Version controlled —
 * edits via the UI write back to the same files so they can be committed.
 */
export class ArtifactSpecStore {
	private specs: Map<string, ArtifactSpec> = new Map();

	constructor() {
		fs.mkdirSync(SPECS_DIR, { recursive: true });
		this.loadAll();
		// Seed defaults if directory is empty
		if (this.specs.size === 0) {
			this.seedDefaults();
		}
	}

	private specFilePath(id: string): string {
		return path.join(SPECS_DIR, `${id}.yaml`);
	}

	private loadAll(): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(SPECS_DIR, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
			const filePath = path.join(SPECS_DIR, entry.name);
			try {
				const raw = fs.readFileSync(filePath, "utf-8");
				const data = parse(raw);
				if (data && typeof data === "object" && data.id) {
					this.specs.set(data.id, {
						id: data.id,
						name: data.name ?? data.id,
						description: data.description ?? "",
						kind: data.kind ?? "analysis",
						format: data.format ?? "markdown",
						mustHave: Array.isArray(data.mustHave) ? data.mustHave : [],
						shouldHave: Array.isArray(data.shouldHave) ? data.shouldHave : [],
						mustNotHave: Array.isArray(data.mustNotHave) ? data.mustNotHave : [],
						requires: Array.isArray(data.requires) ? data.requires : undefined,
						suggestedRole: data.suggestedRole || undefined,
						createdAt: data.createdAt ?? 0,
						updatedAt: data.updatedAt ?? 0,
					});
				}
			} catch (err) {
				console.error(`[artifact-spec-store] Failed to load ${filePath}:`, err);
			}
		}
	}

	private saveOne(spec: ArtifactSpec): void {
		const filePath = this.specFilePath(spec.id);
		try {
			const obj: Record<string, unknown> = {
				id: spec.id,
				name: spec.name,
				description: spec.description,
				kind: spec.kind,
				format: spec.format,
				mustHave: spec.mustHave,
				shouldHave: spec.shouldHave,
				mustNotHave: spec.mustNotHave,
			};
			if (spec.requires && spec.requires.length > 0) obj.requires = spec.requires;
			if (spec.suggestedRole) obj.suggestedRole = spec.suggestedRole;
			obj.createdAt = spec.createdAt;
			obj.updatedAt = spec.updatedAt;

			const content = stringify(obj, { lineWidth: 0 });
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`[artifact-spec-store] Failed to save ${filePath}:`, err);
		}
	}

	private seedDefaults(): void {
		const now = Date.now();
		const defaults = getBuiltinDefaults(now);
		for (const spec of defaults) {
			this.specs.set(spec.id, spec);
			this.saveOne(spec);
		}
	}

	put(spec: ArtifactSpec): void {
		this.specs.set(spec.id, spec);
		this.saveOne(spec);
	}

	get(id: string): ArtifactSpec | undefined {
		return this.specs.get(id);
	}

	remove(id: string): void {
		this.specs.delete(id);
		const filePath = this.specFilePath(id);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
	}

	/** Re-read all YAML files from disk, picking up external changes */
	reload(): void {
		this.specs.clear();
		this.loadAll();
	}

	getAll(): ArtifactSpec[] {
		this.reload();
		return Array.from(this.specs.values());
	}

	update(id: string, updates: Partial<Omit<ArtifactSpec, "id" | "createdAt">>): boolean {
		const existing = this.specs.get(id);
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

function getBuiltinDefaults(now: number): ArtifactSpec[] {
	return [
		{
			id: "design-doc",
			name: "Design Document",
			description: "Architecture decisions, file changes, component breakdown, risks",
			kind: "analysis",
			format: "markdown",
			mustHave: ["Overview section", "Architecture decisions with rationale", "File changes list", "Risk assessment"],
			shouldHave: ["Diagrams or data flow descriptions", "Task breakdown"],
			mustNotHave: [],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "test-plan",
			name: "Test Plan",
			description: "What to test, expected behaviors, edge cases, verification commands",
			kind: "analysis",
			format: "markdown",
			mustHave: ["Test categories (unit/integration/e2e)", "Specific verification commands", "Pass/fail criteria"],
			shouldHave: ["Edge cases", "Performance considerations"],
			mustNotHave: [],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "implementation",
			name: "Implementation",
			description: "Code changes on a branch",
			kind: "deliverable",
			format: "diff",
			mustHave: ["All changes committed", "Type-check passes", "No unrelated changes"],
			shouldHave: [],
			mustNotHave: [],
			requires: ["design-doc", "test-plan"],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "code-review",
			name: "Code Review",
			description: "Expert evaluation of code changes against criteria",
			kind: "review",
			format: "markdown",
			mustHave: ["File:line references", "Severity ratings", "Whether issues were fixed"],
			shouldHave: [],
			mustNotHave: [],
			requires: ["implementation"],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "security-review",
			name: "Security Review",
			description: "Security-focused review of code changes",
			kind: "review",
			format: "markdown",
			mustHave: ["Threat assessment", "Input validation check", "Auth/authz check"],
			shouldHave: [],
			mustNotHave: [],
			requires: ["implementation"],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "test-results",
			name: "Test Results",
			description: "Test execution results and pass/fail summary",
			kind: "verification",
			format: "markdown",
			mustHave: ["Test command and output", "Pass/fail summary", "Failure details if any"],
			shouldHave: [],
			mustNotHave: [],
			requires: ["implementation"],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: "summary-report",
			name: "Summary Report",
			description: "Final completion report for the goal",
			kind: "deliverable",
			format: "html",
			mustHave: ["Goal summary", "Task breakdown", "Test results", "Review findings"],
			shouldHave: [],
			mustNotHave: [],
			createdAt: now,
			updatedAt: now,
		},
	];
}
