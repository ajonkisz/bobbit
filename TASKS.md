## Backlog
- [ ] #1 Server-side: Add `goalAssistant` to `PersistedSession`, `update()` allowed fields, `persistSessionMetadata()`, `restoreSessions()`, and `listSessions()` response — role:coder
- [ ] #2 Client-side: Create `GoalDraftStore` in `src/ui/storage/stores/` for persisting goal assistant draft state to IndexedDB, register it in `AppStorage` and IndexedDB backend — role:coder
- [ ] #3 Client-side: Integrate `GoalDraftStore` with `remote-agent.ts` and `main.ts` — save/restore/cleanup draft state on goal proposal, reconnect, acceptance, and session termination — role:coder, depends:#2
- [ ] #4 Review all changes from tasks #1, #2, #3 — role:reviewer, depends:#1,#2,#3
- [ ] #5 Type-check: run `npm run check` and fix any type errors — role:coder, depends:#1,#2,#3

## In Progress

## Done

## Findings
