## Backlog
- [ ] #23 Dashboard reports viewer: embedded full-screen view of workflow HTML reports linked from commit timeline and task cards — role:coder, depends:#19
- [ ] #25 Test Phase 1 (TaskStore + API) — role:tester, depends:#24
- [ ] #26 Review dashboard implementation (#18-#22) — role:reviewer, depends:#20, depends:#21, depends:#22

## In Progress
- [x] #20 Dashboard kanban board — role:coder, claimed-by:07418c74
- [x] #21 Dashboard agent activity panel — role:coder, claimed-by:9d44f4f8
- [x] #22 Dashboard commit timeline — role:coder, claimed-by:11c43bed

## Done
- [x] #17 Commit-aware stale detection — role:coder, completed-by:coder-1b2663aa
- [x] #18 Sidebar simplification — role:coder, completed-by:coder-5cc090b7
- [x] #19 Goal dashboard route shell — role:coder, completed-by:coder-5cc090b7
- [x] #24 Review Phase 1 (TaskStore + API + WS events) — role:reviewer, completed-by:reviewer-c71341a9
- [x] #14 Server-side TaskStore — role:coder, completed-by:coder-c163b737
- [x] #15 Task REST API — role:coder, completed-by:coder-c163b737
- [x] #16 Task WebSocket events — role:coder, completed-by:coder-c163b737
- [x] #13 Goal dashboard HTML mockup — role:coder, completed-by:coder-621da054
- [x] #1 Server-side: Add `goalAssistant` to `PersistedSession`
- [x] #2 Client-side: Create `GoalDraftStore` for IndexedDB persistence
- [x] #3 Client-side: Integrate `GoalDraftStore` with session-manager.ts and render.ts
- [x] #5 Type-check: `npm run check` passes
- [x] #6 Review goal draft persistence — reviewed, findings addressed
- [x] #7 Test goal draft persistence — existing tests pass
- [x] #8 Fix execSync on Windows
- [x] #9 Verify Team Lead env vars
- [x] #10 Max concurrent + goal completion
- [x] #11 Add merge conflict resolution guidance to Team Lead prompt
- [x] #12 Auto-connect to Team Lead on swarm start + dblclick goal header
- [x] BUG-1: Fix GoalStore.update() undefined field wipe
- [x] BUG-2: Fix corrupted goal data
- [x] BUG-3: Fix execSync ENOENT on Windows

## Findings
- Env vars only passed to Team Lead, not role agents — correct, only Team Lead calls REST API
- maxConcurrent enforced at spawnRole line 237, completeSwarm properly dismisses all agents + worktrees
- GoalStore.update() was using Object.assign with undefined values — fixed with undefined stripping
- #24.1 [medium] TaskStore.update() should strip undefined values like GoalStore fix
- #24.2 [medium] No input validation on REST task endpoints
- #24.3 [medium] Missing auth check on task WebSocket broadcasts
- #24.4 [low] Task IDs should be validated as UUIDs before lookup
