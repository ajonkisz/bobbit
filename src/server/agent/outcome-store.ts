import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface TaskOutcomeInput {
  sessionId: string | null;
  goalId: string;
  taskId: string;
  agentRole: string | null;
  workflowId: string | null;
  gateId: string | null;
  taskType: string;
  taskSummary: string | null;
  outcome: string;
  failureReason: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCallCount: number | null;
  costUsd: number | null;
}

export interface TaskOutcome extends TaskOutcomeInput {
  id: string;
  createdAt: string;
}

export interface OutcomeStats {
  successRateByRole: Record<string, number>;
  avgDurationByType: Record<string, number>;
  totalCost: number;
  totalOutcomes: number;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS task_outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  goal_id TEXT,
  task_id TEXT,
  agent_role TEXT,
  workflow_id TEXT,
  gate_id TEXT,
  task_type TEXT,
  task_summary TEXT,
  outcome TEXT,
  failure_reason TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_call_count INTEGER,
  cost_usd REAL,
  created_at TEXT DEFAULT (datetime('now'))
)`;

const INSERT_SQL = `
INSERT INTO task_outcomes (
  id, session_id, goal_id, task_id, agent_role, workflow_id, gate_id,
  task_type, task_summary, outcome, failure_reason, duration_ms,
  input_tokens, output_tokens, tool_call_count, cost_usd
) VALUES (
  @id, @sessionId, @goalId, @taskId, @agentRole, @workflowId, @gateId,
  @taskType, @taskSummary, @outcome, @failureReason, @durationMs,
  @inputTokens, @outputTokens, @toolCallCount, @costUsd
)`;

export class OutcomeStore {
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
      console.error("[OutcomeStore] Failed to initialize database:", err);
      this.db = null;
      this.insertStmt = null;
    }
  }

  recordOutcome(params: TaskOutcomeInput): void {
    if (!this.db || !this.insertStmt) return;
    try {
      this.insertStmt.run({ id: randomUUID(), ...params });
    } catch (err) {
      console.error("[OutcomeStore] Failed to record outcome:", err);
    }
  }

  getOutcomes(filters?: {
    goalId?: string;
    agentRole?: string;
    outcome?: string;
    since?: string;
  }): TaskOutcome[] {
    if (!this.db) return [];

    const conditions: string[] = [];
    const values: Record<string, string> = {};

    if (filters?.goalId) {
      conditions.push("goal_id = @goalId");
      values.goalId = filters.goalId;
    }
    if (filters?.agentRole) {
      conditions.push("agent_role = @agentRole");
      values.agentRole = filters.agentRole;
    }
    if (filters?.outcome) {
      conditions.push("outcome = @outcome");
      values.outcome = filters.outcome;
    }
    if (filters?.since) {
      conditions.push("created_at >= @since");
      values.since = filters.since;
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM task_outcomes${where} ORDER BY created_at DESC`;

    try {
      const rows = this.db.prepare(sql).all(values) as Record<string, unknown>[];
      return rows.map(mapRow);
    } catch (err) {
      console.error("[OutcomeStore] Failed to query outcomes:", err);
      return [];
    }
  }

  getStats(filters?: {
    goalId?: string;
    agentRole?: string;
    since?: string;
  }): OutcomeStats {
    const empty: OutcomeStats = {
      successRateByRole: {},
      avgDurationByType: {},
      totalCost: 0,
      totalOutcomes: 0,
    };
    if (!this.db) return empty;

    const conditions: string[] = [];
    const values: Record<string, string> = {};

    if (filters?.goalId) {
      conditions.push("goal_id = @goalId");
      values.goalId = filters.goalId;
    }
    if (filters?.agentRole) {
      conditions.push("agent_role = @agentRole");
      values.agentRole = filters.agentRole;
    }
    if (filters?.since) {
      conditions.push("created_at >= @since");
      values.since = filters.since;
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    try {
      // Total outcomes and cost
      const totalsRow = this.db
        .prepare(
          `SELECT COUNT(*) as total, COALESCE(SUM(cost_usd), 0) as cost FROM task_outcomes${where}`,
        )
        .get(values) as { total: number; cost: number };

      // Success rate by role
      const roleRows = this.db
        .prepare(
          `SELECT agent_role,
                  COUNT(*) as total,
                  SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) as completed
           FROM task_outcomes${where}
           GROUP BY agent_role`,
        )
        .all(values) as { agent_role: string | null; total: number; completed: number }[];

      const successRateByRole: Record<string, number> = {};
      for (const row of roleRows) {
        const role = row.agent_role || "unknown";
        successRateByRole[role] = row.total > 0 ? row.completed / row.total : 0;
      }

      // Avg duration by task type
      const durationRows = this.db
        .prepare(
          `SELECT task_type, AVG(duration_ms) as avg_duration
           FROM task_outcomes${where} ${conditions.length ? "AND" : "WHERE"} duration_ms IS NOT NULL
           GROUP BY task_type`,
        )
        .all(values) as { task_type: string; avg_duration: number }[];

      const avgDurationByType: Record<string, number> = {};
      for (const row of durationRows) {
        avgDurationByType[row.task_type] = Math.round(row.avg_duration);
      }

      return {
        successRateByRole,
        avgDurationByType,
        totalCost: totalsRow.cost,
        totalOutcomes: totalsRow.total,
      };
    } catch (err) {
      console.error("[OutcomeStore] Failed to compute stats:", err);
      return empty;
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

function mapRow(row: Record<string, unknown>): TaskOutcome {
  return {
    id: row.id as string,
    sessionId: (row.session_id as string) ?? null,
    goalId: row.goal_id as string,
    taskId: row.task_id as string,
    agentRole: (row.agent_role as string) ?? null,
    workflowId: (row.workflow_id as string) ?? null,
    gateId: (row.gate_id as string) ?? null,
    taskType: row.task_type as string,
    taskSummary: (row.task_summary as string) ?? null,
    outcome: row.outcome as string,
    failureReason: (row.failure_reason as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    toolCallCount: (row.tool_call_count as number) ?? null,
    costUsd: (row.cost_usd as number) ?? null,
    createdAt: row.created_at as string,
  };
}
