import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export type ArtifactType =
	| "design-doc"
	| "test-plan"
	| "review-findings"
	| "gap-analysis"
	| "security-findings"
	| "summary-report"
	| "custom";

export interface GoalArtifact {
	id: string;
	goalId: string;
	name: string;
	type: ArtifactType;
	content: string;
	producedBy: string;
	skillId?: string;
	version: number;
	createdAt: number;
	updatedAt: number;
}

export interface ArtifactRequirement {
	artifactType: ArtifactType;
	blocksTaskTypes: string[];
	description: string;
}

const DEFAULT_REQUIREMENTS: ArtifactRequirement[] = [
	{
		artifactType: "design-doc",
		blocksTaskTypes: ["implementation"],
		description: "A design document must exist before implementation tasks can be created",
	},
	{
		artifactType: "test-plan",
		blocksTaskTypes: ["implementation"],
		description: "A test plan must exist before implementation tasks can be created",
	},
	{
		artifactType: "review-findings",
		blocksTaskTypes: ["goal-completion"],
		description: "Code review findings must exist before the goal can be completed",
	},
];

export function getDefaultRequirements(): ArtifactRequirement[] {
	return DEFAULT_REQUIREMENTS.map((r) => ({ ...r }));
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-goal-artifacts.json");

export class GoalArtifactStore {
	private artifacts: Map<string, GoalArtifact> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const a of data) {
						if (a.id) {
							this.artifacts.set(a.id, a);
						}
					}
				}
			}
		} catch (err) {
			console.error("[goal-artifact-store] Failed to load persisted artifacts:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.artifacts.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[goal-artifact-store] Failed to save artifacts:", err);
		}
	}

	create(artifact: Omit<GoalArtifact, "id" | "version" | "createdAt" | "updatedAt">): GoalArtifact {
		const now = Date.now();
		const full: GoalArtifact = {
			...artifact,
			id: randomUUID(),
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		this.artifacts.set(full.id, full);
		this.save();
		return full;
	}

	get(id: string): GoalArtifact | undefined {
		return this.artifacts.get(id);
	}

	getByGoalId(goalId: string): GoalArtifact[] {
		return Array.from(this.artifacts.values()).filter((a) => a.goalId === goalId);
	}

	update(id: string, updates: Partial<Pick<GoalArtifact, "name" | "type" | "content" | "skillId">>): GoalArtifact | undefined {
		const existing = this.artifacts.get(id);
		if (!existing) return undefined;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, {
			version: existing.version + 1,
			updatedAt: Date.now(),
		});
		this.save();
		return existing;
	}

	delete(id: string): boolean {
		const existed = this.artifacts.has(id);
		if (existed) {
			this.artifacts.delete(id);
			this.save();
		}
		return existed;
	}
}
