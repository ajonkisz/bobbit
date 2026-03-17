## Backlog
- [ ] #18 Sidebar simplification: replace 3-button cluster on goal group headers with single dashboard-link icon, move edit/delete/create-session to dashboard — role:coder, depends:#15
- [ ] #19 Goal dashboard route: add /goal/:id route in main.ts, create GoalDashboard Lit component shell with nav bar (goal title, branch, action buttons, back link) — role:coder, depends:#18


- [ ] #26 Fix: validate type/status on PUT /api/goals/:id/tasks/:taskId — role:coder, depends:#24
- [ ] #27 Fix: cascade-delete tasks when a goal is deleted — role:coder, depends:#24
- [ ] #25 Test Phase 1 (TaskStore + API) — role:tester, depends:#24
- [ ] #29 Test stale detection (#17) — role:tester, depends:#17
- [ ] #31 Test commit timeline (#22) — role:tester, depends:#22
- [ ] #33 Test dashboard kanban board (#20) — role:tester, depends:#20
- [ ] #35 Test dashboard agent activity panel (#21) — role:tester, depends:#21
- [ ] #36 Fix: command injection in commits API via goal.branch — role:coder, depends:#28
- [ ] #37 Fix: dashboard not subscribed to WS task events for real-time updates — role:coder, depends:#32
- [ ] #38 Fix: agent polling timer leaks when navigating away before fetch completes — role:coder, depends:#34
- [ ] #39 Fix: stale detection only compares exact SHA, not ancestry — role:coder, depends:#28

## In Progress

## Done
- [x] #23 Dashboard reports viewer: embedded full-screen view of workflow HTML reports linked from commit timeline and task cards — role:coder, depends:#19, completed-by:coder-4c3415a0
- [x] #28 Review stale detection (#17) — role:reviewer, completed-by:reviewer-25e4d241
- [x] #30 Review commit timeline (#22) — role:reviewer, completed-by:reviewer-25e4d241
- [x] #32 Review dashboard kanban board (#20) — role:reviewer, completed-by:reviewer-25e4d241
- [x] #34 Review dashboard agent activity panel (#21) — role:reviewer, completed-by:reviewer-25e4d241
- [x] #21 Dashboard agent activity panel: show active agents with role, current task, status, session links — role:coder, depends:#19, completed-by:coder-29e822fb
- [x] #20 Dashboard kanban board: render tasks in Backlog/In Progress/Done/Failed columns with type icons, assigned agent, elapsed time — role:coder, completed-by:coder-4463feee
- [x] #22 Dashboard commit timeline: linear commit history on goal branch with status badges derived from task completions — role:coder, completed-by:coder-ec3592d1
- [x] #24 Review Phase 1 (TaskStore + API + WS events) — role:reviewer, completed-by:reviewer-c71341a9
- [x] #17 Commit-aware stale detection: when goal branch HEAD advances past a task's commitSha, mark test/review tasks as stale — role:coder, depends:#15, completed-by:coder-1b2663aa
- [x] #14 Server-side TaskStore: persist tasks to ~/.pi/gateway-tasks.json — role:coder, completed-by:coder-c163b737
- [x] #15 Task REST API: CRUD endpoints — role:coder, completed-by:coder-c163b737
- [x] #16 Task WebSocket events — role:coder, completed-by:coder-c163b737
- [x] #1 Server-side: Add `goalAssistant` to `PersistedSession`
- [x] #2 Client-side: Create `GoalDraftStore` for IndexedDB persistence
- [x] #3 Client-side: Integrate `GoalDraftStore` with session-manager.ts and render.ts
- [x] #5 Type-check: `npm run check` passes
- [x] #6 Review goal draft persistence — reviewed, findings addressed
- [x] #7 Test goal draft persistence — existing tests pass
- [x] #8 Fix execSync on Windows — added shell option to all execSync calls (git.ts, goal-manager.ts, tls.ts, harness.ts)
- [x] #9 Verify Team Lead env vars — CONFIRMED: already passed (line 176 swarm-manager.ts)
- [x] #10 Max concurrent + goal completion — CONFIRMED: already implemented
- [x] #11 Add merge conflict resolution guidance to Team Lead prompt
- [x] #12 Auto-connect to Team Lead on swarm start + dblclick goal header
- [x] BUG-1: Fix GoalStore.update() undefined field wipe
- [x] BUG-2: Fix corrupted goal data — restored all fields
- [x] BUG-3: Fix execSync ENOENT on Windows

## Findings
- Env vars only passed to Team Lead, not role agents — correct, only Team Lead calls REST API
- maxConcurrent enforced at spawnRole line 237, completeSwarm properly dismisses all agents + worktrees
- GoalStore.update() was using Object.assign with undefined values — fixed with undefined stripping

### #24 Review: Phase 1 (TaskStore + REST API + WS events)
- #24.1 [medium] PUT endpoint accepts arbitrary strings for `type` and `status` — no validation against TaskType/TaskStatus unions. POST validates `type` but PUT does not. — file:src/server/server.ts:347
- #24.2 [medium] PUT endpoint passes empty strings through (e.g. `body.type = ""`) since TaskStore.update() only strips `undefined`, not falsy values. Combined with #24.1, update path has weaker guarantees than create. — file:src/server/server.ts:348
- #24.3 [medium] `broadcastToAll` sends task events to every connected client across all sessions, leaking task metadata for unrelated goals. Acceptable for MVP but should scope to goal-related sessions later. — file:src/server/agent/session-manager.ts:866
- #24.4 [low] Task orphaning: deleting a goal does not cascade-delete its tasks from gateway-tasks.json. Stale data accumulates on disk. — file:src/server/agent/task-store.ts
- #24.5 [low] WS protocol types `task_created` and `task_updated` use `task: unknown` instead of `PersistedTask`. Consistent with existing workflow events but weaker than necessary since the type is in the same codebase. — file:src/server/ws/protocol.ts:52
- #24.6 [low] `broadcastToAll` uses magic number `1` instead of `WebSocket.OPEN`. Consistent with existing `broadcast()` helper but less readable. — file:src/server/agent/session-manager.ts:869
- #24.7 [low] No 405 Method Not Allowed for unsupported methods on task endpoints — falls through to later routes. Pre-existing pattern, not a regression. — file:src/server/server.ts:310

### #28 Review: Stale Detection (#17)
- #28.1 [high] Command injection in commits API: `goal.branch` is interpolated directly into `git log "${branch}"` shell command. If a goal's branch field contains `"; rm -rf /"`, the double-quotes don't prevent injection on all shells. The branch value comes from PUT /api/goals/:id which accepts arbitrary strings. — file:src/server/server.ts:421
- #28.2 [medium] Stale detection uses exact SHA comparison (`task.commitSha !== newCommitSha`). If a task was completed at a commit that is an ancestor of the new HEAD (not the same commit), it's marked stale even though its results may still be valid. This is overly aggressive — a test at commit A is still valid at commit B if B is a descendant and only touched unrelated files. Acceptable for MVP but will cause noise. — file:src/server/agent/task-manager.ts:55
- #28.3 [low] `getGoalBranchHead()` uses `execSync` which blocks the Node.js event loop. Should use `execFile` or `spawn` async variant for production use. — file:src/server/agent/task-manager.ts:9
- #28.4 [low] `shell: true as unknown as string` type cast in `getGoalBranchHead` is a workaround for a type mismatch. Works but is fragile — the Node.js types expect `boolean | string`, this casts `true` to `string`. — file:src/server/agent/task-manager.ts:9

### #30 Review: Commit Timeline (#22)
- #30.1 [high] Same command injection issue as #28.1 — the commits endpoint interpolates `goal.branch` into a shell command. See #28.1. — file:src/server/server.ts:421
- #30.2 [medium] `formatRelativeTime` computes relative times from `Date.now()` at render time but the dashboard doesn't auto-refresh. Commit timestamps become stale ("5m ago" stays showing "5m ago" indefinitely). Agent panel polls every 5s but the main content does not re-render. — file:src/app/goal-dashboard.ts:261
- #30.3 [low] `deriveBadges` only matches tasks to commits by exact `commitSha`. If multiple test tasks target the same commit, the last one processed wins (no priority for pass vs fail). — file:src/app/goal-dashboard.ts:231
- #30.4 [low] The git log `--format` string uses `%s` (subject) which truncates at newline. Multi-line commit messages show only the first line. This is actually desirable for a timeline view. No action needed.

### #32 Review: Dashboard Kanban Board (#20)
- #32.1 [medium] Dashboard does not subscribe to WebSocket `task_created`/`task_updated`/`task_deleted` events. Tasks only update on page load. If an agent creates or completes a task while the dashboard is open, the user won't see it until they navigate away and back. This contradicts the goal spec's "real-time updates" requirement. — file:src/app/goal-dashboard.ts
- #32.2 [medium] Stale tasks are bucketed into the "Done" column (`task.status === "stale" ? "done" : task.status`). While they show a "Stale" badge, putting them in Done is misleading — they represent invalidated results. Consider a separate visual treatment or dimming them more aggressively. — file:src/app/goal-dashboard.ts:184
- #32.3 [low] `getElapsedTime` for in-progress tasks uses `Date.now() - task.createdAt` but doesn't auto-refresh. The elapsed time display is static. — file:src/app/goal-dashboard.ts:117
- #32.4 [low] Type duplication: `Task` interface and `TaskType`/`TaskStatus` types are redefined in goal-dashboard.ts, separate from the server's `PersistedTask` in task-store.ts. A shared types file would prevent drift. — file:src/app/goal-dashboard.ts:17

### #34 Review: Dashboard Agent Activity Panel (#21)
- #34.1 [medium] Agent polling timer (`setInterval` every 5s) is not cancelled if navigation happens during an in-flight `fetchAgents` request. The `.then()` callback sets `agents` and calls `renderApp()` even after `clearDashboardState()` has run, potentially causing stale renders. — file:src/app/goal-dashboard.ts:367
- #34.2 [medium] The `renderApp()` call inside the polling callback triggers a full app re-render every 5 seconds, even when agent data hasn't changed. Should diff against previous state before re-rendering. — file:src/app/goal-dashboard.ts:374
- #34.3 [low] `agentStatusLabel` maps "starting" to "blocked" which is semantically wrong — a starting agent isn't blocked, it's initializing. — file:src/app/goal-dashboard.ts:392
- #34.4 [low] `AVATAR_COLORS` array and hash-based color assignment duplicates the session color system from `session-colors.ts`. Should reuse the existing color store. — file:src/app/goal-dashboard.ts:405
- #34.5 [low] No ARIA labels or keyboard navigation on agent rows. Clicking connects to a session but there's no focus indicator or `role="button"` attribute. — file:src/app/goal-dashboard.ts:435

**Overall dashboard positive notes**: Clean separation of concerns — data fetching, rendering, and state are well-organized. CSS is comprehensive with proper responsive breakpoints. Loading and error states are handled. The two-column layout with sticky nav is solid. Commit timeline parsing with NUL/SOH separators is robust. `Promise.all` for parallel data fetching is correct. The `.catch(() => null)` on commits gracefully handles repos without git.

**Positive notes**: TaskStore correctly follows GoalStore's load-on-construct/write-on-mutate pattern. The undefined-stripping bug from GoalStore (BUG-1) is proactively avoided. UUID generation via `crypto.randomUUID()` is correct. REST nesting under `/api/goals/:id/tasks` is clean. Goal existence check on collection endpoints prevents creating tasks for nonexistent goals. Cross-validation of `task.goalId !== goalId` on individual task endpoints prevents accessing tasks via wrong goal URL.
