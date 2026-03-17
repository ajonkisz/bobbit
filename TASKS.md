## Backlog
- [ ] #12 Auto-open Team Lead session when clicking swarm goal in sidebar — role:coder

## In Progress
- [ ] #8 Fix execSync on Windows — add shell:true to all execSync calls in git.ts — role:coder
- [ ] #11 Add merge conflict resolution guidance to Team Lead prompt in swarm-prompts.ts — role:coder

## Done
- [x] #1 Server-side: Add `goalAssistant` to `PersistedSession`
- [x] #2 Client-side: Create `GoalDraftStore` for IndexedDB persistence
- [x] #3 Client-side: Integrate `GoalDraftStore` with session-manager.ts and render.ts
- [x] #5 Type-check: `npm run check` passes
- [x] #6 Review goal draft persistence — reviewed, findings addressed
- [x] #7 Test goal draft persistence — existing tests pass
- [x] #9 Verify Team Lead env vars — CONFIRMED: already passed (line 176 swarm-manager.ts)
- [x] #10 Max concurrent + goal completion — CONFIRMED: already implemented (line 237 + completeSwarm)
- [x] BUG-1: Fix GoalStore.update() undefined field wipe — commit b88f057
- [x] BUG-2: Fix corrupted goal data — restored all fields

## Findings
- #9: Env vars only passed to Team Lead, not role agents — but role agents don't need them (only Team Lead calls REST API)
- #10: maxConcurrent enforced at line 237, completeSwarm at line 394 properly dismisses all agents + worktrees + updates goal state
