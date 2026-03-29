import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface PromptProposal {
  id: string;
  observerSessionId: string | null;
  targetType: string;
  targetName: string;
  reasoning: string;
  evidence: string | null;
  proposedDiff: string;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
}

export interface ProposalInput {
  observerSessionId?: string | null;
  targetType: string;
  targetName: string;
  reasoning: string;
  evidence?: string | null;
  proposedDiff: string;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS prompt_proposals (
  id TEXT PRIMARY KEY,
  observer_session_id TEXT,
  target_type TEXT NOT NULL,
  target_name TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  evidence TEXT,
  proposed_diff TEXT NOT NULL,
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

const LIST_ALL_SQL = `SELECT * FROM prompt_proposals ORDER BY created_at DESC`;

const LIST_BY_STATUS_SQL = `SELECT * FROM prompt_proposals WHERE status = @status ORDER BY created_at DESC`;

const GET_BY_ID_SQL = `SELECT * FROM prompt_proposals WHERE id = @id`;

const UPDATE_STATUS_SQL = `
UPDATE prompt_proposals
SET status = @status, reviewed_at = datetime('now')
WHERE id = @id`;

export class ProposalStore {
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private listAllStmt: Database.Statement | null = null;
  private listByStatusStmt: Database.Statement | null = null;
  private getByIdStmt: Database.Statement | null = null;
  private updateStatusStmt: Database.Statement | null = null;

  constructor() {
    try {
      const stateDir = bobbitStateDir();
      fs.mkdirSync(stateDir, { recursive: true });
      const dbPath = path.join(stateDir, "outcomes.db");
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(CREATE_TABLE);
      this.insertStmt = this.db.prepare(INSERT_SQL);
      this.listAllStmt = this.db.prepare(LIST_ALL_SQL);
      this.listByStatusStmt = this.db.prepare(LIST_BY_STATUS_SQL);
      this.getByIdStmt = this.db.prepare(GET_BY_ID_SQL);
      this.updateStatusStmt = this.db.prepare(UPDATE_STATUS_SQL);
    } catch (err) {
      console.error("[ProposalStore] Failed to initialize database:", err);
      this.db = null;
    }
  }

  create(input: ProposalInput): PromptProposal {
    const id = randomUUID();
    const params = {
      id,
      observerSessionId: input.observerSessionId ?? null,
      targetType: input.targetType,
      targetName: input.targetName,
      reasoning: input.reasoning,
      evidence: input.evidence ?? null,
      proposedDiff: input.proposedDiff,
    };

    if (!this.db || !this.insertStmt || !this.getByIdStmt) {
      // Return a best-effort object when DB is unavailable
      return {
        ...params,
        status: "pending",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
      };
    }

    try {
      this.insertStmt.run(params);
      const row = this.getByIdStmt.get({ id }) as Record<string, unknown> | undefined;
      return row ? mapRow(row) : {
        ...params,
        status: "pending",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
      };
    } catch (err) {
      console.error("[ProposalStore] Failed to create proposal:", err);
      return {
        ...params,
        status: "pending",
        createdAt: new Date().toISOString(),
        reviewedAt: null,
      };
    }
  }

  list(filters?: { status?: string }): PromptProposal[] {
    if (!this.db) return [];

    try {
      let rows: Record<string, unknown>[];
      if (filters?.status) {
        rows = (this.listByStatusStmt?.all({ status: filters.status }) ?? []) as Record<string, unknown>[];
      } else {
        rows = (this.listAllStmt?.all() ?? []) as Record<string, unknown>[];
      }
      return rows.map(mapRow);
    } catch (err) {
      console.error("[ProposalStore] Failed to list proposals:", err);
      return [];
    }
  }

  getById(id: string): PromptProposal | undefined {
    if (!this.db || !this.getByIdStmt) return undefined;

    try {
      const row = this.getByIdStmt.get({ id }) as Record<string, unknown> | undefined;
      return row ? mapRow(row) : undefined;
    } catch (err) {
      console.error("[ProposalStore] Failed to get proposal:", err);
      return undefined;
    }
  }

  updateStatus(id: string, status: "approved" | "rejected"): PromptProposal | undefined {
    if (!this.db || !this.updateStatusStmt || !this.getByIdStmt) return undefined;

    try {
      const result = this.updateStatusStmt.run({ id, status });
      if (result.changes === 0) return undefined;
      const row = this.getByIdStmt.get({ id }) as Record<string, unknown> | undefined;
      return row ? mapRow(row) : undefined;
    } catch (err) {
      console.error("[ProposalStore] Failed to update proposal status:", err);
      return undefined;
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
      this.listAllStmt = null;
      this.listByStatusStmt = null;
      this.getByIdStmt = null;
      this.updateStatusStmt = null;
    }
  }
}

function mapRow(row: Record<string, unknown>): PromptProposal {
  return {
    id: row.id as string,
    observerSessionId: (row.observer_session_id as string) ?? null,
    targetType: row.target_type as string,
    targetName: row.target_name as string,
    reasoning: row.reasoning as string,
    evidence: (row.evidence as string) ?? null,
    proposedDiff: row.proposed_diff as string,
    status: row.status as string,
    createdAt: row.created_at as string,
    reviewedAt: (row.reviewed_at as string) ?? null,
  };
}
