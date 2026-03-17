## Backlog
- [ ] #17 Commit-aware stale detection: when goal branch HEAD advances past a task's commitSha, mark test/review tasks as stale — role:coder, depends:#15
- [ ] #18 Sidebar simplification: replace 3-button cluster on goal group headers with single dashboard-link icon, move edit/delete/create-session to dashboard — role:coder, depends:#15
- [ ] #19 Goal dashboard route: add /goal/:id route in main.ts, create GoalDashboard Lit component shell with nav bar (goal title, branch, action buttons, back link) — role:coder, depends:#18
- [ ] #20 Dashboard kanban board: render tasks in Backlog/In Progress/Done/Failed columns with type icons, assigned agent, elapsed time — role:coder, depends:#19
- [ ] #21 Dashboard agent activity panel: show active agents with role, current task, status, session links — role:coder, depends:#19
- [ ] #22 Dashboard commit timeline: linear commit history on goal branch with status badges derived from task completions — role:coder, depends:#17, depends:#19
- [ ] #23 Dashboard reports viewer: embedded full-screen view of workflow HTML reports linked from commit timeline and task cards — role:coder, depends:#19
- [ ] #24 Review Phase 1 (TaskStore + API + WS events) — role:reviewer, depends:#16
- [ ] #25 Test Phase 1 (TaskStore + API) — role:tester, depends:#24

## In Progress

## Done
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
