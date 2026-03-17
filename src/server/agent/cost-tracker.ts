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

const STORE_DIR = path.join(os.homedir(), ".pi");
const STORE_FILE = path.join(STORE_DIR, "gateway-session-costs.json");

/**
 * Tracks cumulative per-session cost data.
 * Persists to disk so costs survive server restarts.
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
						if (cost && typeof cost === "object") {
							this.costs.set(id, cost as SessionCost);
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
	 * Record usage from a message_update event.
	 * Accumulates tokens and cost into the session's cumulative total.
	 * Returns the updated cumulative cost.
	 */
	recordUsage(sessionId: string, usage: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cost?: number;
	}): SessionCost {
		const existing = this.costs.get(sessionId) || {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0,
		};

		existing.inputTokens += usage.inputTokens || 0;
		existing.outputTokens += usage.outputTokens || 0;
		existing.cacheReadTokens += usage.cacheReadTokens || 0;
		existing.cacheWriteTokens += usage.cacheWriteTokens || 0;
		existing.totalCost += usage.cost || 0;

		this.costs.set(sessionId, existing);
		this.save();
		return { ...existing };
	}

	/**
	 * Get cumulative cost for a session.
	 */
	getCost(sessionId: string): SessionCost | undefined {
		const cost = this.costs.get(sessionId);
		return cost ? { ...cost } : undefined;
	}

	/**
	 * Get costs for multiple sessions, aggregated.
	 */
	getAggregateCost(sessionIds: string[]): SessionCost {
		const aggregate: SessionCost = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0,
		};
		for (const id of sessionIds) {
			const cost = this.costs.get(id);
			if (cost) {
				aggregate.inputTokens += cost.inputTokens;
				aggregate.outputTokens += cost.outputTokens;
				aggregate.cacheReadTokens += cost.cacheReadTokens;
				aggregate.cacheWriteTokens += cost.cacheWriteTokens;
				aggregate.totalCost += cost.totalCost;
			}
		}
		return aggregate;
	}

	/**
	 * Remove cost data for a session.
	 */
	remove(sessionId: string): void {
		this.costs.delete(sessionId);
		this.save();
	}
}
