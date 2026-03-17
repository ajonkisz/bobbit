## Backlog

## In Progress
- [x] #6 Review goal draft persistence changes (main vs master diff) — role:reviewer
- [x] #7 Test GoalDraftStore and draft lifecycle (save/restore/cleanup) — role:tester

## Done
- [x] #1 Server-side: Add `goalAssistant` to `PersistedSession`, `update()` allowed fields, `persistSessionMetadata()`, `restoreSessions()`, and `listSessions()` response
- [x] #2 Client-side: Create `GoalDraftStore` in `src/ui/storage/stores/` for persisting goal assistant draft state to IndexedDB, register it in `AppStorage` and IndexedDB backend
- [x] #3 Client-side: Integrate `GoalDraftStore` with `session-manager.ts` and `render.ts` — save/restore/cleanup draft state on goal proposal, reconnect, acceptance, and session termination
- [x] #5 Type-check: `npm run check` passes

## Findings
