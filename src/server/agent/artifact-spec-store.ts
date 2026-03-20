import fs from "node:fs";
import path from "node:path";
import { piDir } from "../pi-dir.js";

export type ArtifactKind = "analysis" | "deliverable" | "review" | "verification";
export type ArtifactFormat = "markdown" | "html" | "diff" | "command";

export interface ArtifactSpec {
	id: string;
	name: string;
	description: string;
	kind: ArtifactKind;
	format: ArtifactFormat;
	mustHave: string[];
	shouldHave: string[];
	mustNotHave: string[];
	requires?: string[];
	suggestedRole?: string;
	createdAt: number;
	updatedAt: number;
}

function getBuiltinDefaults(): ArtifactSpec[] {
	const now = Date.now();
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

const STORE_DIR = piDir();
const STORE_FILE = path.join(STORE_DIR, "gateway-artifact-specs.json");

export class ArtifactSpecStore {
	private specs: Map<string, ArtifactSpec> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.id) {
							this.specs.set(s.id, s);
						}
					}
				}
			}
		} catch (err) {
			console.error("[artifact-spec-store] Failed to load persisted specs:", err);
		}

		// Seed with built-in defaults if store is empty
		if (this.specs.size === 0) {
			for (const spec of getBuiltinDefaults()) {
				this.specs.set(spec.id, spec);
			}
			this.save();
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.specs.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[artifact-spec-store] Failed to save specs:", err);
		}
	}

	create(input: Omit<ArtifactSpec, "createdAt" | "updatedAt">): ArtifactSpec {
		if (this.specs.has(input.id)) {
			throw new Error(`Artifact spec with id "${input.id}" already exists`);
		}
		const now = Date.now();
		const spec: ArtifactSpec = {
			...input,
			createdAt: now,
			updatedAt: now,
		};
		this.specs.set(spec.id, spec);
		this.save();
		return spec;
	}

	get(id: string): ArtifactSpec | undefined {
		return this.specs.get(id);
	}

	getAll(): ArtifactSpec[] {
		return Array.from(this.specs.values());
	}

	update(id: string, updates: Partial<Omit<ArtifactSpec, "id" | "createdAt">>): ArtifactSpec | undefined {
		const existing = this.specs.get(id);
		if (!existing) return undefined;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined && k !== "id" && k !== "createdAt") cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.save();
		return existing;
	}

	delete(id: string): boolean {
		const existed = this.specs.has(id);
		if (existed) {
			this.specs.delete(id);
			this.save();
		}
		return existed;
	}
}
