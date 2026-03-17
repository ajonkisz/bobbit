## Backlog
- [ ] #10 Review all task tracking code — role:reviewer, depends:#4,#5,#6,#7,#8,#9
- [ ] #12 Type-check: `npm run check` passes — role:tester, depends:#9

## In Progress
- [x] #9 Session ↔ Task integration — auto-assign task on session creation with `taskId`, goal deletion cascades to tasks — role:coder, claimed-by:21957dc2
- [x] #11 Review cost tracking code — role:reviewer, claimed-by:3bc5977e

## Done
- [x] #1 Implement TaskStore (`src/server/agent/task-store.ts`) — role:coder, completed-by:6bebd675
- [x] #3 Implement CostTracker (`src/server/agent/cost-tracker.ts`) — role:coder, completed-by:37bc6bcb
- [x] #2 Implement TaskManager (`src/server/agent/task-manager.ts`) — role:coder, completed-by:ecf5378c
- [x] #8 Integrate cost tracking into SessionManager — role:coder, completed-by:4779048d
- [x] #5 Add Cost REST API endpoints to `server.ts` — role:coder, completed-by:98a6a0c2
- [x] #4 Add Task REST API endpoints to `server.ts` — role:coder, completed-by:4eb358a5
- [x] #7 Integrate tasks into system prompt assembly (`system-prompt.ts`) — role:coder, completed-by:36216a90
- [x] #6 Add Task + Cost WebSocket protocol messages to `protocol.ts` and handle in `handler.ts` — role:coder, completed-by:coder-11932ace

## Findings
