import fs from "node:fs";
import path from "node:path";
import type { QueuedMessage } from "../ws/protocol.js";
import { piDir } from "../pi-dir.js";

/** Persisted metadata for a single gateway session */
export interface PersistedSession {
	id: string;
	title: string;
	cwd: string;
	/** The agent's .jsonl session file path — needed to resume */
	agentSessionFile: string;
	createdAt: number;
	lastActivity: number;
	/** Optional goal this session belongs to */
	goalId?: string;
	/** Whether the agent was actively streaming when the server last knew about it */
	wasStreaming?: boolean;
	/** If this session is a delegate, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester') */
	role?: string;
	/** The team goal this agent belongs to */
	teamGoalId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Whether this is a goal-creation assistant session */
	goalAssistant?: boolean;
	/** Whether this is a role-creation assistant session */
	roleAssistant?: boolean;
	/** Task ID this session is working on */
	taskId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** Persisted prompt queue */
	messageQueue?: QueuedMessage[];
}

const STORE_DIR = piDir();
const STORE_FILE = path.join(STORE_DIR, "gateway-sessions.json");

/**
 * Simple JSON file store for gateway session metadata.
 * Allows sessions to survive server restarts.
 */
export class SessionStore {
	private sessions: Map<string, PersistedSession> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.id && s.agentSessionFile) {
							// Migrate legacy 'swarmGoalId' field to 'teamGoalId'
							if (s.swarmGoalId !== undefined && s.teamGoalId === undefined) {
								s.teamGoalId = s.swarmGoalId;
								delete s.swarmGoalId;
							}
							this.sessions.set(s.id, s);
						}
					}
				}
			}
		} catch (err) {
			console.error("[session-store] Failed to load persisted sessions:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.sessions.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[session-store] Failed to save sessions:", err);
		}
	}

	put(session: PersistedSession): void {
		this.sessions.set(session.id, session);
		this.save();
	}

	get(id: string): PersistedSession | undefined {
		return this.sessions.get(id);
	}

	remove(id: string): void {
		this.sessions.delete(id);
		this.save();
	}

	getAll(): PersistedSession[] {
		return Array.from(this.sessions.values());
	}

	/** Update a subset of fields for an existing session */
	update(id: string, updates: Partial<Pick<PersistedSession, "title" | "lastActivity" | "agentSessionFile" | "goalId" | "wasStreaming" | "delegateOf" | "role" | "teamGoalId" | "worktreePath" | "goalAssistant" | "roleAssistant" | "taskId" | "accessory" | "preview" | "messageQueue">>): void {
		const existing = this.sessions.get(id);
		if (!existing) return;
		Object.assign(existing, updates);
		this.save();
	}
}
