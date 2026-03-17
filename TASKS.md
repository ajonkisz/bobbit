## Backlog

## In Progress
- [x] #27 Fix review findings: command injection, input validation, real-time updates, scoped broadcasts — role:coder, claimed-by:9695faca

## Done
- [x] #23 Dashboard reports viewer — role:coder, completed-by:coder-4c3415a0
- [x] #25 Test Phase 1 — role:tester, completed-by:tester-7db03d04
- [x] #26 Review dashboard implementation — role:reviewer, completed-by:reviewer-25e4d241
- [x] #20 Dashboard kanban board — role:coder, completed-by:coder-4463feee
- [x] #21 Dashboard agent activity panel — role:coder, completed-by:coder-29e822fb
- [x] #22 Dashboard commit timeline — role:coder, completed-by:coder-4463feee
- [x] #17 Commit-aware stale detection — role:coder, completed-by:coder-1b2663aa
- [x] #18 Sidebar simplification — role:coder, completed-by:coder-5cc090b7
- [x] #19 Goal dashboard route shell — role:coder, completed-by:coder-5cc090b7
- [x] #24 Review Phase 1 (TaskStore + API + WS events) — role:reviewer, completed-by:reviewer-c71341a9
- [x] #14 Server-side TaskStore — role:coder, completed-by:coder-c163b737
- [x] #15 Task REST API — role:coder, completed-by:coder-c163b737
- [x] #16 Task WebSocket events — role:coder, completed-by:coder-c163b737
- [x] #13 Goal dashboard HTML mockup — role:coder, completed-by:coder-621da054
- [x] #1-#12, BUG-1-3: Prior foundation work

## Findings
- #28.1 [high] Command injection in git log — branch interpolated into shell command — FIXING in #27
- #30.1 [high] Same command injection in commits endpoint — FIXING in #27
- #24.1 [medium] PUT endpoint lacks type/status validation — FIXING in #27
- #24.2 [medium] PUT passes empty strings through — FIXING in #27
- #24.3 [medium] Task broadcasts leak to all clients — FIXING in #27
- #32.1 [medium] Dashboard doesn't subscribe to WS task events — FIXING in #27
- #32.2 [medium] Stale tasks bucketed into Done column — FIXING in #27
- #28.2 [medium] Stale detection overly aggressive (exact SHA comparison)
- #30.2 [medium] Relative timestamps don't auto-refresh
- #32.3 [low] Elapsed time display is static
- #32.4 [low] Type duplication between client/server
- #24.4-#24.7, #28.3-#28.4, #30.3-#30.4 [low] Various minor issues
