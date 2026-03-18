import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TEAM_LEAD_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, TESTER_PROMPT } from "./swarm-prompts.js";

export interface Role {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Markdown system prompt template (supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders) */
	promptTemplate: string;
	/** Subset of allowed agent tools — empty array means "all tools allowed" */
	allowedTools: string[];
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory: string;
	createdAt: number;
	updatedAt: number;
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-roles.json");

/**
 * Simple JSON file store for roles.
 * Roles persist across server restarts.
 * Seeds with default roles on first run.
 */
export class RoleStore {
	private roles: Map<string, Role> = new Map();

	constructor() {
		this.load();
		if (this.roles.size === 0) {
			this.seed();
		}
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const r of data) {
						if (r.name) {
							this.roles.set(r.name, r);
						}
					}
				}
			}
		} catch (err) {
			console.error("[role-store] Failed to load persisted roles:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.roles.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[role-store] Failed to save roles:", err);
		}
	}

	private seed(): void {
		const now = Date.now();

		const defaults: Role[] = [
			{
				name: "team-lead",
				label: "Team Lead",
				promptTemplate: TEAM_LEAD_PROMPT,
				allowedTools: [],
				accessory: "crown",
				createdAt: now,
				updatedAt: now,
			},
			{
				name: "coder",
				label: "Coder",
				promptTemplate: CODER_PROMPT,
				allowedTools: [],
				accessory: "bandana",
				createdAt: now,
				updatedAt: now,
			},
			{
				name: "reviewer",
				label: "Reviewer",
				promptTemplate: REVIEWER_PROMPT,
				allowedTools: [],
				accessory: "magnifier",
				createdAt: now,
				updatedAt: now,
			},
			{
				name: "tester",
				label: "Tester",
				promptTemplate: TESTER_PROMPT,
				allowedTools: [],
				accessory: "goggles",
				createdAt: now,
				updatedAt: now,
			},
		];

		for (const role of defaults) {
			this.roles.set(role.name, role);
		}
		this.save();
		console.log("[role-store] Seeded default roles: team-lead, coder, reviewer, tester");
	}

	put(role: Role): void {
		this.roles.set(role.name, role);
		this.save();
	}

	get(name: string): Role | undefined {
		return this.roles.get(name);
	}

	remove(name: string): void {
		this.roles.delete(name);
		this.save();
	}

	getAll(): Role[] {
		return Array.from(this.roles.values());
	}

	update(name: string, updates: Partial<Omit<Role, "name" | "createdAt">>): boolean {
		const existing = this.roles.get(name);
		if (!existing) return false;
		const cleaned: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(updates)) {
			if (v !== undefined) cleaned[k] = v;
		}
		Object.assign(existing, cleaned, { updatedAt: Date.now() });
		this.save();
		return true;
	}
}
