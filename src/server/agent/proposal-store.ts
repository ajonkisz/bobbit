import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface ProposalInput {
  observerSessionId?: string;
  targetType: "role_prompt" | "agents_md" | "system_prompt" | "workflow";
  targetName: string;
  reasoning: string;
  evidence: string;
  proposedDiff: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS prompt_proposals (
  id TEXT PRIMARY KEY,
  observer_session_id TEXT,
  target_type TEXT,
  target_name TEXT,
  reasoning TEXT,
  evidence TEXT,
  proposed_diff TEXT,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  reviewed_at TEXT
)`;

const INSERT_SQL = `
INSERT INTO prompt_proposals (
  id, observer_session_id, target_type, target_name,
  reasoning, evidence, proposed_diff
) VALUES (
  @id, @observerSessionId, @targetType, @targetName,
  @reasoning, @evidence, @proposedDiff
)`;

export class ProposalStore {
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;

  constructor() {
    try {
      const stateDir = bobbitStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      const dbPath = path.join(stateDir, "outcomes.db");
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(CREATE_TABLE);
      this.insertStmt = this.db.prepare(INSERT_SQL);
    } catch (err) {
      console.error("[ProposalStore] Failed to initialize database:", err);
      this.db = null;
      this.insertStmt = null;
    }
  }

  create(params: ProposalInput): Proposal {
    const id = randomUUID();
    const row: Proposal = {
      id,
      observerSessionId: params.observerSessionId,
      targetType: params.targetType,
      targetName: params.targetName,
      reasoning: params.reasoning,
      evidence: params.evidence,
      proposedDiff: params.proposedDiff,
      status: "pending",
      createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      reviewedAt: null,
    };

    if (!this.db || !this.insertStmt) {
      throw new Error("ProposalStore database not initialized");
    }

    try {
      this.insertStmt.run({
        id,
        observerSessionId: params.observerSessionId ?? null,
        targetType: params.targetType,
        targetName: params.targetName,
        reasoning: params.reasoning,
        evidence: params.evidence,
        proposedDiff: params.proposedDiff,
      });
      return row;
    } catch (err) {
      console.error("[ProposalStore] Failed to create proposal:", err);
      throw err;
    }
  }

  list(filters?: { status?: string }): Proposal[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const values: Record<string, string> = {};

    if (filters?.status) {
      conditions.push("status = @status");
      values.status = filters.status;
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM prompt_proposals${where} ORDER BY created_at DESC`;

    try {
      const rows = this.db.prepare(sql).all(values) as Record<string, unknown>[];
      return rows.map(mapRow);
    } catch (err) {
      console.error("[ProposalStore] Failed to list proposals:", err);
      return [];
    }
  }

  getById(id: string): Proposal | undefined {
    if (!this.db) return undefined;

    try {
      const row = this.db
        .prepare("SELECT * FROM prompt_proposals WHERE id = @id")
        .get({ id }) as Record<string, unknown> | undefined;
      return row ? mapRow(row) : undefined;
    } catch (err) {
      console.error("[ProposalStore] Failed to get proposal:", err);
      return undefined;
    }
  }

  updateStatus(id: string, status: "approved" | "rejected"): boolean {
    if (!this.db) return false;

    try {
      const result = this.db
        .prepare(
          "UPDATE prompt_proposals SET status = @status, reviewed_at = datetime('now') WHERE id = @id",
        )
        .run({ id, status });
      return result.changes > 0;
    } catch (err) {
      console.error("[ProposalStore] Failed to update proposal status:", err);
      return false;
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
      this.db = null;
      this.insertStmt = null;
    }
  }
}

function mapRow(row: Record<string, unknown>): Proposal {
  return {
    id: row.id as string,
    observerSessionId: (row.observer_session_id as string) ?? undefined,
    targetType: row.target_type as Proposal["targetType"],
    targetName: row.target_name as string,
    reasoning: row.reasoning as string,
    evidence: row.evidence as string,
    proposedDiff: row.proposed_diff as string,
    status: row.status as Proposal["status"],
    createdAt: row.created_at as string,
    reviewedAt: (row.reviewed_at as string) ?? null,
  };
}
