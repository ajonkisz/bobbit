import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SessionCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
}

export interface UsageData {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
}

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-session-costs.json");

function emptyCost(): SessionCost {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalCost: 0,
	};
}

/**
 * Tracks cumulative per-session cost/usage data.
 * Persists to ~/.pi/gateway-session-costs.json.
 * Same load-on-construct, write-on-mutate pattern as GoalStore/SessionStore.
 */
export class CostTracker {
	private costs: Map<string, SessionCost> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, cost] of Object.entries(data)) {
						if (id && cost && typeof cost === "object") {
							const c = cost as Record<string, unknown>;
							this.costs.set(id, {
								inputTokens: typeof c.inputTokens === "number" ? c.inputTokens : 0,
								outputTokens: typeof c.outputTokens === "number" ? c.outputTokens : 0,
								cacheReadTokens: typeof c.cacheReadTokens === "number" ? c.cacheReadTokens : 0,
								cacheWriteTokens: typeof c.cacheWriteTokens === "number" ? c.cacheWriteTokens : 0,
								totalCost: typeof c.totalCost === "number" ? c.totalCost : 0,
							});
						}
					}
				}
			}
		} catch (err) {
			console.error("[cost-tracker] Failed to load persisted costs:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data: Record<string, SessionCost> = {};
			for (const [id, cost] of this.costs) {
				data[id] = cost;
			}
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[cost-tracker] Failed to save costs:", err);
		}
	}

	/**
	 * Add usage data to the cumulative totals for a session.
	 * Handles partial usage objects — undefined fields are treated as 0.
	 */
	recordUsage(sessionId: string, usage: UsageData): SessionCost {
		const existing = this.costs.get(sessionId) ?? emptyCost();
		existing.inputTokens += usage.inputTokens ?? 0;
		existing.outputTokens += usage.outputTokens ?? 0;
		existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		existing.totalCost += usage.cost ?? 0;
		existing.totalCost = Math.round(existing.totalCost * 1_000_000) / 1_000_000;
		this.costs.set(sessionId, existing);
		this.save();
		return { ...existing };
	}

	getSessionCost(sessionId: string): SessionCost | undefined {
		const cost = this.costs.get(sessionId);
		return cost ? { ...cost } : undefined;
	}

	/**
	 * Aggregate cost across multiple sessions (caller provides session IDs).
	 * Returns a combined SessionCost. Sessions without cost data are skipped.
	 */
	getGoalCost(goalId: string, sessionIds: string[]): SessionCost {
		const total = emptyCost();
		for (const sid of sessionIds) {
			const c = this.costs.get(sid);
			if (c) {
				total.inputTokens += c.inputTokens;
				total.outputTokens += c.outputTokens;
				total.cacheReadTokens += c.cacheReadTokens;
				total.cacheWriteTokens += c.cacheWriteTokens;
				total.totalCost += c.totalCost;
			}
		}
		return total;
	}

	getAllCosts(): Map<string, SessionCost> {
		return new Map(this.costs);
	}

	removeSession(sessionId: string): void {
		if (this.costs.delete(sessionId)) {
			this.save();
		}
	}
}
