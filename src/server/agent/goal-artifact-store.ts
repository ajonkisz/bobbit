import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { piDir } from "../pi-dir.js";

export interface GoalArtifact {
	id: string;
	goalId: string;
	name: string;
	type: string;
	content: string;
	producedBy: string;
	skillId?: string;
	specId?: string;
	/** Links to a workflow artifact definition within the goal's workflow snapshot */
	workflowArtifactId?: string;
	/** Result of automated verification steps */
	verificationResult?: {
		steps: Array<{ name: string; type: string; passed: boolean; output: string }>;
	};
	/** Reason the artifact was rejected during verification */
	rejectionReason?: string;
	status?: "submitted" | "accepted" | "rejected";
	version: number;
	createdAt: number;
	updatedAt: number;
}

const STORE_DIR = piDir();
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
							// Migration: existing artifacts without status are accepted
							if (a.status === undefined) {
								a.status = "accepted";
							}
							// Migration: map legacy specId to workflowArtifactId
							if (a.specId && !a.workflowArtifactId) {
								a.workflowArtifactId = a.specId;
							}
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
			status: artifact.status ?? "submitted",
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

	update(id: string, updates: Partial<Pick<GoalArtifact, "name" | "type" | "content" | "skillId" | "status" | "workflowArtifactId" | "verificationResult" | "rejectionReason">>): GoalArtifact | undefined {
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
