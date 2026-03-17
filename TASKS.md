## Backlog
- [ ] #1 Implement TaskStore (`src/server/agent/task-store.ts`) — JSON persistence at `~/.pi/gateway-tasks.json`, same pattern as GoalStore — role:coder
- [ ] #2 Implement TaskManager (`src/server/agent/task-manager.ts`) — CRUD, state transitions, dependency cycle detection, sub-task validation, cascading deletes — role:coder, depends:#1
- [ ] #3 Implement CostTracker (`src/server/agent/cost-tracker.ts`) — per-session cost aggregation, persist to `~/.pi/gateway-session-costs.json`, reload on startup — role:coder
- [ ] #4 Add Task REST API endpoints to `server.ts` — all 7 endpoints from spec (GET/POST/PUT/DELETE tasks, assign, transition) — role:coder, depends:#2
- [ ] #5 Add Cost REST API endpoints to `server.ts` — session cost, goal cost, task cost aggregation — role:coder, depends:#3
- [ ] #6 Add Task + Cost WebSocket protocol messages to `protocol.ts` and handle in `handler.ts` — role:coder, depends:#4,#5
- [ ] #7 Integrate tasks into system prompt assembly (`system-prompt.ts`) — include task type, title, spec, dependsOn context — role:coder, depends:#2
- [ ] #8 Integrate cost tracking into SessionManager — intercept `message_update` events with `usage.cost` — role:coder, depends:#3
- [ ] #9 Session ↔ Task integration — auto-assign task on session creation with `taskId`, goal deletion cascades to tasks — role:coder, depends:#2,#4
- [ ] #10 Review all task tracking code — role:reviewer, depends:#4,#5,#6,#7,#8,#9
- [ ] #11 Review cost tracking code — role:reviewer, depends:#5,#8
- [ ] #12 Type-check: `npm run check` passes — role:tester, depends:#9

## In Progress

## Done

## Findings
