# Goals, Workflows, Tasks & Artifacts

This document explains how Bobbit's goal orchestration system works — how goals, workflows, tasks, and artifacts relate to each other, and how context flows between agents.

## Concepts

### Goals

A **goal** is a unit of work with a title, spec (markdown), working directory, and state (`todo` | `in-progress` | `complete` | `shelved`). Goals optionally create a dedicated git worktree for isolated work.

Goals can run in **team mode**, where a Team Lead agent orchestrates multiple role agents (coders, reviewers, testers) working concurrently in their own worktrees.

### Workflows

A **workflow** is a reusable template that defines which artifacts a goal must produce, their dependency relationships (a DAG), quality criteria, and verification configs. Workflows are stored as YAML files in `workflows/` at the repo root.

When a goal is created with a `workflowId`, the entire workflow is **snapshotted** into `PersistedGoal.workflow`. This frozen copy is immune to later template edits — the goal's requirements are locked at creation time.

Goals without workflows still work fine — workflows are optional.

#### Workflow data model

```typescript
interface WorkflowArtifact {
  id: string;              // Unique within this workflow, e.g. "issue-analysis"
  name: string;            // Display name
  description: string;     // What this artifact is
  kind: "analysis" | "deliverable" | "review" | "verification";
  format: "markdown" | "html" | "diff" | "command";
  dependsOn: string[];     // Other artifact IDs within THIS workflow (the DAG)
  mustHave: string[];      // Non-negotiable quality criteria
  shouldHave: string[];    // Recommended but not required
  mustNotHave: string[];   // Disqualifying traits
  suggestedRole?: string;  // Role best suited to produce this
  verification?: VerificationConfig;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  artifacts: WorkflowArtifact[];
  createdAt: number;
  updatedAt: number;
}
```

#### Dependency DAG

Each workflow artifact's `dependsOn` lists sibling artifact IDs that must be accepted before it can be submitted. This serves two purposes:

1. **Submission gating** — the server returns 409 if you try to submit an artifact before its dependencies are accepted.
2. **Context injection** — when an agent is spawned to produce an artifact, the accepted content of its dependencies is automatically injected into the agent's system prompt.

#### Verification

Workflow artifacts can define automated verification that runs when the artifact is submitted:

- **Command** — runs shell commands, checks exit codes (e.g. "test fails on master, passes on fix branch")
- **LLM review** — spawns a sub-agent for qualitative review against criteria
- **Combined** — mechanical + qualitative steps in sequence

Verification is async. On submission, the artifact status transitions to `"submitted"`. If verification is defined, it runs in the background. On completion: `"accepted"` (all steps pass) or `"rejected"` (any step fails, with details). A WebSocket event `artifact_verification_complete` is emitted. If no verification is defined, the artifact is auto-accepted.

### Tasks

**Tasks** are the operational work items within a goal. They track what needs to be done, who's doing it, and what state it's in.

Tasks have a state machine: `todo` → `in-progress` → `complete` | `skipped` | `blocked`.

Tasks can declare:
- **`dependsOn`** — other task IDs that must complete first (advisory, not enforced)
- **`workflowArtifactId`** — which workflow artifact this task should produce
- **`inputArtifactIds`** — which workflow artifact IDs to inject as context when prompting the assigned agent

Tasks and workflows are complementary layers:
- **Workflows** = quality layer (what artifacts to produce, in what order, with what criteria)
- **Tasks** = operational layer (who's doing what, status tracking, assignment)

### Artifacts

**Goal artifacts** are the formal documents and deliverables produced during a goal's lifecycle — design docs, test plans, review findings, etc.

Each artifact has:
- `type` — `design-doc`, `test-plan`, `review-findings`, `gap-analysis`, `security-findings`, `custom`
- `content` — markdown or JSON
- `version` — incremented on each update
- `workflowArtifactId` — links to the workflow artifact definition it fulfils (if a workflow is active)
- `status` — `submitted` | `accepted` | `rejected` (when verification is defined)
- `verificationResult` — step-by-step results from verification
- `rejectionReason` — why verification failed

#### Server-enforced gates

Regardless of whether a workflow is present, the server enforces:
- A **`design-doc`** artifact must exist before any `implementation` task can be created (409 on `task_create`).
- A **`review-findings`** artifact must exist before the goal can be completed via `team_complete` (409).

When a workflow IS present, additional gates apply:
- An artifact with `workflowArtifactId` can only be created once all its workflow dependencies have accepted artifacts (409 with details of what's missing).
- `team_complete` requires every workflow artifact to have an accepted goal artifact.

## Context injection

Context injection is the mechanism that feeds accepted upstream artifact content into agent prompts. This is how the design doc shapes the implementation, and the issue analysis feeds the reproducing test.

### At spawn time (`team_spawn`)

When spawning an agent via `team_spawn`, you can pass:

- **`workflowArtifactId`** (0 or 1) — declares which workflow artifact the agent should produce. If `inputArtifactIds` is not set, the server auto-resolves inputs from the DAG's `dependsOn`.
- **`inputArtifactIds`** (0 or more) — explicit list of workflow artifact IDs whose accepted content to inject. Overrides automatic DAG resolution.

The resolved artifact content is injected into the agent's **system prompt** under a `# Upstream Artifacts` section.

**Examples:**
```
# Auto-resolve from DAG (implementation depends on issue-analysis + reproducing-test):
team_spawn(role="coder", task="Implement the fix", workflowArtifactId="implementation")

# Explicit inputs (reviewer needs more context than the formal DAG requires):
team_spawn(role="reviewer", task="Review the fix",
  workflowArtifactId="code-review",
  inputArtifactIds=["issue-analysis", "implementation", "test-results"])
```

### At prompt time (`team_prompt`)

When prompting an existing agent with new work via `team_prompt`, you can pass the same parameters:

- **`workflowArtifactId`** (optional) — what the agent should produce next
- **`inputArtifactIds`** (optional) — which artifacts to inject as context

The resolved artifact content is **prepended to the prompt message**, so the agent receives fresh context for the new task without needing to be respawned.

**Example:**
```
team_prompt(session_id="abc", message="Now review the implementation",
  workflowArtifactId="code-review",
  inputArtifactIds=["issue-analysis", "implementation", "test-results"])
```

### On artifact creation (`artifact_create`)

When creating a goal artifact, pass `workflowArtifactId` to link it to the workflow definition. This enables:
- Dependency gating (server checks all upstream dependencies are accepted)
- Verification (if the workflow artifact has a verification config)
- Completion tracking (the goal dashboard shows which workflow artifacts are fulfilled)

## How it all fits together

Here's the typical flow for a team goal with a workflow:

```
1. User creates a goal with workflowId="bug-fix"
   → Server snapshots the bug-fix workflow into the goal

2. Team Lead reads the workflow, sees the artifact DAG:
   issue-analysis → reproducing-test → implementation → code-review
                                      ↘ test-results → bug-fix-report

3. Team Lead creates tasks linked to workflow artifacts:
   task_create(title="Analyse the bug", type="custom",
     workflowArtifactId="issue-analysis")

4. Team Lead spawns an agent with artifact context:
   team_spawn(role="coder", task="Analyse the bug",
     workflowArtifactId="issue-analysis")
   → Agent gets the goal spec in its system prompt (no upstream deps for first artifact)

5. Agent produces the analysis:
   artifact_create(name="Issue Analysis", type="custom", content="...",
     workflowArtifactId="issue-analysis")
   → Server runs verification (if configured) → status: accepted

6. Team Lead spawns next agent with upstream context:
   team_spawn(role="tester", task="Write reproducing test",
     workflowArtifactId="reproducing-test")
   → Agent receives the accepted issue-analysis content in its system prompt

7. Or reuses an existing agent with fresh context:
   team_prompt(session_id="existing-agent",
     message="Now write the reproducing test",
     workflowArtifactId="reproducing-test",
     inputArtifactIds=["issue-analysis"])
   → Agent receives the issue-analysis content prepended to the prompt

8. Process continues through the DAG until all artifacts are accepted

9. team_complete() — server verifies all workflow artifacts are fulfilled
```

## REST API reference

### Workflows

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workflows` | List all workflow templates |
| `GET` | `/api/workflows/:id` | Get full workflow detail |
| `POST` | `/api/workflows` | Create a workflow |
| `PUT` | `/api/workflows/:id` | Update a workflow |
| `DELETE` | `/api/workflows/:id` | Delete (blocked if in-use by active goals) |
| `POST` | `/api/workflows/:id/clone` | Deep-copy a workflow with a new ID |

### Goal artifacts (workflow-aware)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/artifacts` | Create artifact — accepts `workflowArtifactId` for linking + gating |
| `PUT` | `/api/goals/:id/artifacts/:aid` | Update artifact — re-triggers verification if linked to workflow |
| `GET` | `/api/goals/:id/workflow-context/:wfArtifactId` | Get resolved dependency context for a workflow artifact |

### Tasks (artifact-linked)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/tasks` | Create task — accepts `workflowArtifactId` and `inputArtifactIds` |
| `PUT` | `/api/tasks/:id` | Update task — accepts `workflowArtifactId` and `inputArtifactIds` |

### Team (context injection)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/goals/:id/team/spawn` | Spawn agent — `workflowArtifactId` + `inputArtifactIds` for context injection |
| `POST` | `/api/goals/:id/team/prompt` | Prompt agent — `workflowArtifactId` + `inputArtifactIds` prepended to message |

## Storage

| Location | What |
|---|---|
| `workflows/*.yaml` | Workflow templates (repo-local, version controlled) |
| `~/.pi/gateway-goals.json` | Goals with snapshotted workflows |
| `~/.pi/gateway-goal-artifacts.json` | Goal artifacts with workflow links and verification results |
| `~/.pi/gateway-tasks.json` | Tasks with workflow artifact links |

## Key source files

| File | Purpose |
|---|---|
| `src/server/agent/workflow-store.ts` | YAML persistence for workflow templates |
| `src/server/agent/workflow-manager.ts` | Workflow CRUD, DAG validation, cloning |
| `src/server/agent/verification-harness.ts` | Async verification (command + LLM review) |
| `src/server/agent/goal-artifact-store.ts` | Goal artifact storage with workflow linking |
| `src/server/agent/task-store.ts` | Task persistence with `workflowArtifactId` and `inputArtifactIds` |
| `src/server/agent/team-manager.ts` | Context injection via `buildDependencyContext()` |
| `src/server/agent/system-prompt.ts` | System prompt assembly including workflow context |
| `extensions/goal-tools.ts` | Agent tools: `artifact_create`, `task_create` with workflow params |
| `extensions/team-lead-tools.ts` | Agent tools: `team_spawn`, `team_prompt` with context injection |
| `roles/team-lead.yaml` | Team Lead prompt template (workflow-aware) |
| `workflows/bug-fix.yaml` | Seed workflow: bug fix lifecycle |
