# Bobbit Implementation Goals

## Execution Order

| # | Goal | Depends on | Size |
|---|---|---|---|
| 2.5 | Active memory usage | Goal 1 (done) | Small |
| 3 | Observer staff agent | Goal 2 | Large |
| 4 | Proposals UI | Goal 3 | Medium |
| 5 | Project registry | None (parallel with 3/4) | Medium |
| 6 | Budget enforcement | Goal 5 | Medium |
| 7 | Multi-project goals | Goals 5 + 6 | Large |

Goals 5 and 6 can start in parallel with Goals 3 and 4 — they're independent branches. Goal 7 is the capstone that brings everything together.

---

## Goal 2.5: Active Memory Usage in Agent Prompts

Agents currently have access to memory MCP tools (memory, graphiti, codebase-memory-mcp)
but don't know they should use them. Update system prompt and role configurations so
agents actively read from and write to memory.

### Requirements

1. **Update global system prompt** (`.bobbit/config/system-prompt.md`)
   Add a section instructing agents to use memory tools:

   - At task start: call `mcp__memory__search_memory` with a query describing
     the task to find relevant prior learnings. Also call
     `mcp__graphiti__search_memory_facts` if the task involves architecture
     or cross-cutting concerns.
   - For code navigation: prefer `mcp__codebase-memory-mcp__search_graph`
     and `mcp__codebase-memory-mcp__trace_call_path` over grepping when
     looking for functions, classes, or call chains. Fall back to grep/read
     for text content search.
   - At task completion: if you discovered something non-obvious (a gotcha,
     an undocumented pattern, a failure mode), call
     `mcp__memory__add_memories` with `infer` set to true to record it.
     Don't record things already in AGENTS.md or obvious from the code.
   - For significant architectural decisions or entity relationships, call
     `mcp__graphiti__add_memory` to record them in the knowledge graph.

   Keep the instructions concise (10-15 lines). Don't over-prescribe — agents
   should use judgment about when memory is relevant.

2. **Add memory tools to role allowedTools**
   Update each role YAML in `.bobbit/config/roles/` to include memory tools
   in their `allowedTools` list:
   - All roles: `mcp__memory__search_memory`, `mcp__memory__add_memories`,
     `mcp__memory__list_memories`
   - All roles: `mcp__graphiti__search_memory_facts`, `mcp__graphiti__search_nodes`,
     `mcp__graphiti__add_memory`
   - All roles: `mcp__codebase-memory-mcp__search_graph`,
     `mcp__codebase-memory-mcp__trace_call_path`,
     `mcp__codebase-memory-mcp__get_architecture`,
     `mcp__codebase-memory-mcp__get_code_snippet`

   Check what tool names are actually registered by looking at the MCP server
   connections (GET /api/tools or check tool-activation.ts). Use the exact
   registered names with the `mcp__<server>__<tool>` format.

3. **Inject project context for Graphiti group_id**
   When assembling the system prompt, include a note about which Graphiti
   group_id to use. For now, derive it from the project directory name
   (last segment of the cwd path). Example: if cwd is
   `/Users/aj/Documents/Development/bobbit`, the group_id hint should be `bobbit`.

   Add this to the assembled prompt near the memory instructions:
   "When using graphiti tools, pass group_id: '{projectName}' to scope
   memories to this project."

### Files to modify
- `.bobbit/config/system-prompt.md` — add memory usage instructions
- `.bobbit/config/roles/*.yaml` — add memory tools to allowedTools
- `src/server/agent/system-prompt.ts` — inject group_id hint

### Verification
- Start a new session, check the assembled prompt in
  `.bobbit/state/session-prompts/` contains memory instructions
- Ask the agent "what do you know about this project?" — it should call
  memory search tools
- Complete a task where the agent discovers something — verify it calls
  add_memories

---

## Goal 3: Observer Staff Agent

Create a staff agent that analyzes task outcomes and agent memories to propose
improvements to role prompts and AGENTS.md.

### Requirements

1. **Outcome stats API** (if not already added by Goal 2)
   - `GET /api/outcomes/stats` — aggregate statistics:
     - Success rate by agent role
     - Average duration by task type
     - Total cost by goal
     - Most common failure reasons
     - Tasks that took >2x average duration

2. **Proposal store**
   - New file: `src/server/agent/proposal-store.ts`
   - SQLite table (can share outcomes.db or use separate file):
     ```sql
     CREATE TABLE prompt_proposals (
       id TEXT PRIMARY KEY,
       observer_session_id TEXT,
       target_type TEXT,     -- 'role_prompt' | 'agents_md' | 'system_prompt' | 'workflow'
       target_name TEXT,     -- role name, 'global', or workflow name
       reasoning TEXT,       -- why the observer thinks this change helps
       evidence TEXT,        -- JSON array of outcome IDs and memory references
       proposed_diff TEXT,   -- the actual text to add/change
       status TEXT DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
       created_at TEXT DEFAULT (datetime('now')),
       reviewed_at TEXT
     );
     ```
   - Methods: create, list (filter by status), update status, get by id

3. **Observer assistant definition**
   - New file: `.bobbit/config/roles/assistant/observer.yaml`
   - The observer prompt should instruct the agent to:
     a. Call `GET /api/outcomes?since={7_days_ago}` to get recent outcomes
     b. Call `GET /api/outcomes/stats` for aggregate patterns
     c. Call `mcp__memory__search_memory("common failures patterns problems")`
        for agent learnings
     d. Call `mcp__graphiti__search_memory_facts("project patterns decisions")`
        for institutional knowledge
     e. Analyze the data looking for:
        - Roles with high failure rates → suggest prompt improvements
        - Repeated failure reasons → suggest AGENTS.md additions
        - Cost outliers → suggest workflow or model changes
        - Learnings in memory that should be in prompts → propose additions
     f. For each finding, create a proposal via `POST /api/proposals` with:
        - target_type and target_name
        - Clear reasoning with cited evidence
        - Specific proposed text change (not vague suggestions)

4. **REST API for proposals**
   - `GET /api/proposals` — list proposals, optional `?status=pending`
   - `GET /api/proposals/:id` — single proposal
   - `POST /api/proposals` — create (used by observer agent)
   - `PUT /api/proposals/:id` — update status (approve/reject)
   - On approval with target_type `role_prompt`: update the role YAML file
   - On approval with target_type `agents_md`: append to AGENTS.md
   - On approval with target_type `system_prompt`: append to system-prompt.md

5. **Claude Code memory writeback on approval**
   - When a proposal is approved and applied, also write a summary as a new
     memory file to `~/.claude/projects/{encodedCwd}/memory/`
   - Use the same frontmatter format as Claude Code memories:
     ```markdown
     ---
     name: {short title}
     description: {one-line description}
     type: feedback
     ---
     {the learning content}
     ```
   - Update MEMORY.md index in the same directory

6. **Manual trigger**
   - Add a way to manually trigger the observer:
     `POST /api/observer/run` — creates a new observer session
   - Later we can add scheduled/automatic triggering

### Files to create/modify
- New: `src/server/agent/proposal-store.ts`
- New: `.bobbit/config/roles/assistant/observer.yaml`
- `src/server/server.ts` — proposal API endpoints + observer trigger
- `src/server/agent/session-manager.ts` — observer session creation

### Verification
- Call `POST /api/observer/run` to trigger the observer
- Check the observer session in the UI — it should call outcome and memory APIs
- Check `GET /api/proposals` returns proposals
- Approve a proposal and verify the target file is updated
- Check that a Claude Code memory file was created

---

## Goal 4: Proposals UI

Add a UI page to Bobbit for reviewing and acting on observer proposals.

### Requirements

1. **Proposals page at `#/proposals`**
   - Fetch proposals from `GET /api/proposals`
   - List pending proposals first, then history (approved/rejected)
   - Each proposal card shows:
     - Target badge (role prompt / AGENTS.md / system prompt)
     - Target name (e.g. "coder", "global")
     - Reasoning text
     - Evidence summary (link to outcome IDs if possible)
     - Expandable section showing the proposed diff/text
     - Approve / Reject buttons
     - Timestamp

2. **Diff display**
   - Show proposed_diff in a code block or diff view
   - If it's an addition to AGENTS.md, show it as a markdown preview
   - If it's a role prompt change, show the YAML context

3. **Approval flow**
   - Approve button calls `PUT /api/proposals/:id` with `status: 'approved'`
   - Show a confirmation toast: "Applied to {target}. Written to Claude Code memory."
   - Reject button calls with `status: 'rejected'`
   - Optionally allow a rejection reason (stored in a `review_note` field)

4. **Nav integration**
   - Add "Proposals" link to the navigation bar
   - Show a badge with count of pending proposals (poll on same 5s cycle
     as sessions/goals, or use a lightweight endpoint)
   - Badge only shows when count > 0

5. **Empty state**
   - When no proposals exist: "No proposals yet. The observer will analyze
     task outcomes and suggest improvements after enough data is collected.
     Trigger manually via the API: POST /api/observer/run"

### Component structure
Follow existing patterns (Lit components, similar to goals dashboard):
- New: `src/ui/components/ProposalsDashboard.ts` — main page component
- New: `src/ui/components/ProposalCard.ts` — individual proposal display
- Modify: `src/app/state.ts` — add proposals state + generation tracking
- Modify: `src/app/render.ts` — route `#/proposals` to ProposalsDashboard
- Modify: nav component — add Proposals link + badge

### Verification
- Create a test proposal via `POST /api/proposals` with realistic data
- Navigate to `#/proposals`, verify it renders correctly
- Approve the proposal, verify the target file is updated
- Verify the badge disappears when no pending proposals remain

---

## Goal 5: Project Registry and Creation Tools

Add a project registry so Bobbit can manage multiple projects from a single
instance, with tools for creating new projects.

### Requirements

1. **Project config**
   - New config file: `.bobbit/config/projects.yaml`
   - Schema:
     ```yaml
     projects:
       bobbit:
         path: /Users/aj/Documents/Development/bobbit
         repo: git@github.com:aj/bobbit.git
         graphiti_group: bobbit
         description: "Multi-agent orchestration platform"
       ruflo:
         path: /Users/aj/Documents/Development/ruflo
         repo: git@github.com:aj/ruflo.git
         graphiti_group: ruflo
         description: "Claude Code swarm extension"
     ```
   - Fields: path (required), repo (optional), graphiti_group (default: dir name),
     description (optional), default_workflow (optional)

2. **ProjectManager**
   - New file: `src/server/agent/project-manager.ts`
   - Loads projects.yaml, provides lookup by name or path
   - Auto-detects: scan `path` for git remote to populate `repo` if missing
   - Method: `getProjectForCwd(cwd)` — returns project config for a session's
     working directory (matches by path prefix)
   - Method: `createProject(name, opts)` — creates directory, git init,
     optionally `gh repo create --private`, registers in projects.yaml

3. **Project tools for agents**
   - New tool group `.bobbit/config/tools/project/`:
     - `project_list` — list all registered projects with path, repo, description
     - `project_info(name)` — detailed info: recent goals, outcome stats,
       memory count, last active date
     - `project_create(name, path?, private?, description?)` — create new
       project directory, init git, create GitHub repo if `private` flag set,
       register in projects.yaml, create initial AGENTS.md
   - Extension: `.bobbit/config/tools/project/extension.ts` calling
     ProjectManager methods via gateway API

4. **Inject project context into sessions**
   - When creating a session, look up the project via `getProjectForCwd(cwd)`
   - Inject project info into the system prompt:
     - Project name and description
     - Graphiti group_id to use
     - Related projects (if any share path prefixes or are subprojects)
   - Pass graphiti_group to memory tool instructions

5. **REST API**
   - `GET /api/projects` — list all projects
   - `GET /api/projects/:name` — single project with stats
   - `POST /api/projects` — create new project
   - `PUT /api/projects/:name` — update project config

6. **Auto-discovery** (optional nice-to-have)
   - On first run, scan common locations (e.g. ~/Documents/Development/*)
     for git repos and offer to register them

### Files to create/modify
- New: `src/server/agent/project-manager.ts`
- New: `src/server/agent/project-store.ts` (YAML read/write)
- New: `.bobbit/config/tools/project/*.yaml` (tool definitions)
- New: `.bobbit/config/tools/project/extension.ts`
- `src/server/agent/system-prompt.ts` — inject project context
- `src/server/server.ts` — project API endpoints

### Verification
- Check `GET /api/projects` returns registered projects
- Create a new session with cwd in a registered project — verify project
  context appears in the assembled prompt with correct graphiti_group
- Test `project_create` via an agent session — verify directory, git init,
  and projects.yaml entry are created

---

## Goal 6: Per-Project Budget Enforcement

Add spending limits per project with hard stops to prevent runaway AI costs.

### Requirements

1. **Budget config in projects.yaml**
   ```yaml
   projects:
     bobbit:
       path: /Users/aj/Documents/Development/bobbit
       budget:
         monthly_usd: 100
         alert_threshold: 0.8  # warn at 80%
     ruflo:
       path: /Users/aj/Documents/Development/ruflo
       budget:
         monthly_usd: 50
   ```

2. **Budget tracking**
   - New file: `src/server/agent/budget-manager.ts`
   - Aggregates cost data from CostTracker per project per calendar month
   - Method: `checkBudget(projectName)` → returns
     `{ spent, limit, remaining, percentage, blocked }`
   - Method: `recordCost(projectName, amount)` — called when sessions
     report token usage

3. **Enforcement points**
   - Before creating a new goal/session: check budget, reject with 402 if
     monthly limit exceeded
   - During session: check periodically (every N tool calls or every cost
     update). If limit exceeded mid-session:
     - Send a system message to the agent: "Budget limit reached for this
       project. Please wrap up your current task and stop."
     - Don't kill the session immediately — let it finish the current turn
   - Budget resets on the 1st of each month

4. **REST API**
   - `GET /api/projects/:name/budget` — current budget status
   - `GET /api/budget/summary` — all projects budget overview
   - `PUT /api/projects/:name/budget` — update budget limits

5. **Alert via system message**
   - When spend reaches alert_threshold (default 80%), inject a warning into
     the next agent prompt: "Budget alert: {percentage}% of monthly budget
     used for project {name}. {remaining} USD remaining."

6. **UI indicator**
   - Show budget usage in the goal dashboard or session sidebar
   - Color coding: green (<50%), yellow (50-80%), red (>80%), blocked (100%)

### Files to create/modify
- New: `src/server/agent/budget-manager.ts`
- `src/server/agent/project-manager.ts` — read budget config
- `src/server/agent/session-manager.ts` — budget checks on session/goal creation
- `src/server/agent/cost-tracker.ts` — hook cost updates to budget manager
- `src/server/server.ts` — budget API endpoints
- UI components for budget display

### Verification
- Set a low budget (e.g. $1) on a test project
- Run a session until budget is exceeded
- Verify new session creation is blocked with a clear error message
- Verify budget resets when month changes

---

## Goal 7: Multi-Project Goals and Nested Teams

Enable goals that span multiple projects and teams large enough to work on
complex multi-module codebases.

### Requirements

1. **Multi-project goals**
   - Goal creation accepts an optional `projects` array instead of single cwd:
     ```json
     {
       "title": "Unified auth across bobbit and ruflo",
       "projects": ["bobbit", "ruflo"],
       "spec": "..."
     }
     ```
   - The goal's team lead session runs from a parent directory (or the first
     project's directory) and has context about all involved projects
   - Workflow gates can specify which project they apply to:
     ```yaml
     gates:
       design:
         project: bobbit
       implementation-bobbit:
         project: bobbit
         depends_on: [design]
       implementation-ruflo:
         project: ruflo
         depends_on: [design]
       integration-test:
         depends_on: [implementation-bobbit, implementation-ruflo]
     ```

2. **Nested teams (sub-teams per project/subproject)**
   - Team lead can spawn sub-leads for large projects:
     `team_spawn_sublead(project, role, task)` — creates a sub-team lead
     that manages its own role agents for a specific project or subproject
   - Sub-lead reports back to the main lead via task completion
   - Sub-lead gets its own git worktree scoped to its project
   - Task dependencies can cross sub-teams:
     "sub-lead A's implementation gate must pass before sub-lead B starts"

3. **Cross-project memory context**
   - When a goal spans multiple projects, inject all related projects'
     Claude Code memories into the team lead's prompt
   - Graphiti queries use `group_ids` (array) to search across all
     involved projects
   - Memory writes go to the specific project's group_id based on which
     project the agent is working in

4. **Cross-project dependency awareness**
   - Inject into agent context: "Project bobbit depends on ruflo's
     @claude-flow/swarm package" (from projects.yaml or auto-detected
     from package.json/imports)
   - When an agent modifies a shared dependency, flag it:
     "Warning: this module is imported by project X"

5. **Worktree management for multi-project**
   - Each sub-team gets a worktree in its own project directory
   - The main team lead can see all worktrees across projects
   - Cleanup handles worktrees across all involved projects

### Data model changes
- `PersistedGoal`: add optional `projects: string[]` field
- `WorkflowGate`: add optional `project: string` field
- `TeamState`: add optional `parentTeamId` for sub-teams
- New: sub-lead session type with reference to parent team

### Files to create/modify
- `src/server/agent/goal-manager.ts` — multi-project goal creation
- `src/server/agent/team-manager.ts` — sub-team spawning, cross-team deps
- `src/server/agent/workflow-manager.ts` — per-project gate scoping
- `src/server/agent/system-prompt.ts` — cross-project context injection
- `.bobbit/config/tools/team/extension.ts` — team_spawn_sublead tool
- Goal assistant prompt — support multi-project goal proposals

### Verification
- Create a goal spanning two projects
- Verify team lead has context about both projects
- Spawn sub-leads per project, verify each works in correct directory
- Complete a cross-project workflow with gates per project
- Verify memory writes go to correct project group_ids
