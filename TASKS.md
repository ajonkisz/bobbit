# Server-Authoritative Prompt Queue — Tasks

## Done
- [x] #1 Server-side queue + protocol + handler — coder-ed0e3b8b
- [x] #2 Client-side queue rewire — coder-3c8f9172
- [x] #3 Draft persistence — coder-d6ffdd82
- [x] #4 Command history (up-arrow) — coder-26372669
- [x] #5 Code review (16 findings, 4 bugs) — coder-49b643e6
- [x] #6 PromptQueue unit tests (13 tests) — coder-f524e91c
- [x] #7 Bug fixes from review — team-lead
- [x] #8 Queue dispatch integration tests (14 tests) — coder-1f3d0a72
- [x] #9 Draft + history browser tests (8 tests) — coder-69ac1ba3

## Findings
See REVIEW.md for full code review. Key bugs found and fixed:
- drainQueue used steer RPC when agent was idle (should be prompt)
- enqueuePrompt with idle agent + non-empty queue never drained
- steer handler enqueued without draining when idle
- Race condition: no optimistic status update before dispatch
