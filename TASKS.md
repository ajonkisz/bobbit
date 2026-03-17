## Backlog

## In Progress

## Done
- [x] #4 Add Task REST API endpoints to server.ts — role:coder, completed-by:coder-f019216e
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
