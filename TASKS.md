## Backlog
- [ ] #10 Review all task tracking code — role:reviewer, depends:#4,#5,#6,#7,#8,#9
- [ ] #13 Fix: Goal cost endpoint should include terminated sessions — role:coder, depends:#11
- [x] #14 Fix minor review findings — robustness and performance — role:coder, depends:#11, claimed-by:coder-3780b145

## In Progress
- [x] #6 Add Task + Cost WebSocket protocol messages to `protocol.ts` and handle in `handler.ts` — role:coder, claimed-by:6585203b
- [x] #9 Session ↔ Task integration — auto-assign task on session creation with `taskId`, goal deletion cascades to tasks — role:coder, claimed-by:21957dc2


## Done
- [x] #14 Fix minor review findings — robustness and performance — role:coder, completed-by:coder-3780b145
- [x] #12 Type-check: `npm run check` passes — role:tester, completed-by:tester-55f3ffd8
- [x] #11 Review cost tracking code — role:reviewer, completed-by:reviewer-af572498
- [x] #1 Implement TaskStore (`src/server/agent/task-store.ts`) — role:coder, completed-by:6bebd675
- [x] #3 Implement CostTracker (`src/server/agent/cost-tracker.ts`) — role:coder, completed-by:37bc6bcb
- [x] #2 Implement TaskManager (`src/server/agent/task-manager.ts`) — role:coder, completed-by:ecf5378c
- [x] #8 Integrate cost tracking into SessionManager — role:coder, completed-by:4779048d
- [x] #5 Add Cost REST API endpoints to `server.ts` — role:coder, completed-by:98a6a0c2
- [x] #4 Add Task REST API endpoints to `server.ts` — role:coder, completed-by:4eb358a5
- [x] #7 Integrate tasks into system prompt assembly (`system-prompt.ts`) — role:coder, completed-by:36216a90

## Findings

### #11 — Cost Tracking Code Review

- #11.1 [medium] Goal cost endpoint misses terminated sessions — `listSessions()` only returns live in-memory sessions, so `GET /api/goals/:goalId/cost` undercounts if sessions were terminated. Cost data persists in the tracker but session-to-goal mapping is lost once the session is removed from the in-memory map. Fix: query cost tracker keys and cross-reference with persisted session store, or persist goalId in cost data. — file:src/server/server.ts:775
- #11.2 [medium] `getSessionCost()` returns mutable internal reference — the `Map.get()` return is the live object, so callers could mutate internal state. `recordUsage` correctly returns a spread copy, but `getSessionCost` does not. The REST endpoint in server.ts passes this directly to `json()` which serializes it (safe), but any in-process caller could corrupt data. — file:src/server/agent/cost-tracker.ts:94
- #11.3 [medium] `load()` does not validate numeric fields — loaded data is cast as `SessionCost` without checking that fields are actually numbers. Corrupted or hand-edited JSON could introduce NaN values that propagate through all subsequent accumulations. — file:src/server/agent/cost-tracker.ts:52
- #11.4 [low] Synchronous file write on every usage event — `save()` calls `writeFileSync` on every `recordUsage()` call, which blocks the event loop. For busy sessions with many tool calls, this could add latency. Consider debounced/batched writes or async writes. — file:src/server/agent/cost-tracker.ts:72
- #11.5 [low] `getGoalCost` accepts unused `goalId` parameter — the method takes `goalId` as first argument but never uses it; only `sessionIds` is used. This is misleading API design. — file:src/server/agent/cost-tracker.ts:102
- #11.6 [low] `cost_update` WS message missing `goalId` and `taskId` — the goal spec defines `cost_update` as `{ sessionId, goalId?, taskId?, cost }` but the implementation only sends `sessionId` and `cost`. Clients would need extra lookups to associate costs with goals/tasks. — file:src/server/ws/protocol.ts:55
- #11.7 [low] Floating-point accumulation on `totalCost` — repeated `+=` on floats will gradually lose precision over many messages. Not a practical issue for most sessions, but for very long-running ones, consider rounding or using integer cents. — file:src/server/agent/cost-tracker.ts:88
- #11.8 [suggestion] No cost data cleanup on session termination — `terminateSession()` removes session metadata but does not call `costTracker.removeSession()`. Cost data for terminated sessions accumulates indefinitely in the JSON file. This may be intentional for historical reporting, but should be documented either way. — file:src/server/agent/session-manager.ts:676

No critical or high severity issues found. The implementation is correct for the core accumulation and persistence flow — no double-counting occurs on restart since only new events are tracked, and the load-on-construct pattern correctly reloads persisted data.
