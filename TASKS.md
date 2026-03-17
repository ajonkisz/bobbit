## Backlog
- [ ] #15 Final review of fixes — role:reviewer, depends:#13,#14
- [ ] #16 Final type-check — role:tester, depends:#13,#14

## In Progress
- [x] #13 Fix critical/major review findings (C1, M4, M5, m2, cleanup) — role:coder, claimed-by:7bb51a3f
- [x] #14 Fix minor review findings (m1, m4, m5, m7, S4) — role:coder, claimed-by:f91180c7

## Done
- [x] #1 Implement TaskStore — role:coder, completed-by:6bebd675
- [x] #2 Implement TaskManager — role:coder, completed-by:ecf5378c
- [x] #3 Implement CostTracker — role:coder, completed-by:37bc6bcb
- [x] #4 Add Task REST API endpoints — role:coder, completed-by:4eb358a5
- [x] #5 Add Cost REST API endpoints — role:coder, completed-by:98a6a0c2
- [x] #6 Add Task + Cost WebSocket protocol messages — role:coder, completed-by:6585203b
- [x] #7 Integrate tasks into system prompt assembly — role:coder, completed-by:36216a90
- [x] #8 Integrate cost tracking into SessionManager — role:coder, completed-by:4779048d
- [x] #9 Session ↔ Task integration — role:coder, completed-by:21957dc2
- [x] #10 Comprehensive code review — role:reviewer, completed-by:7e051782
- [x] #11 Review cost tracking code — role:reviewer, completed-by:3bc5977e
- [x] #12 Type-check and build verification — role:tester, completed-by:8c41a5c0

## Findings
- #10.C1 [critical] updateTask() bypasses sub-task completion validation — file:task-manager.ts
- #10.M4 [major] No TaskType/TaskState input validation on REST endpoints — file:server.ts
- #10.M5 [major] No goalId existence validation on task creation — file:server.ts
- #10.m1 [minor] N disk writes on batch delete — file:task-manager.ts
- #10.m2 [minor] cost_update missing goalId/taskId — file:session-manager.ts
- #10.m3 [minor] Unused goalId param in getGoalCost — file:cost-tracker.ts
- #10.m4 [minor] Goal cost only counts in-memory sessions — file:server.ts
- #10.m5 [minor] dependsOn not validated for duplicates/self-refs — file:task-manager.ts
- #10.m7 [minor] No data shape validation on load — file:task-store.ts
- #10.S4 [suggestion] Floating-point cost accumulation — file:cost-tracker.ts
- #12.W1 [warning] Unused goalId param in getGoalCost — file:cost-tracker.ts:102
- #12.W2 [warning] Unused SessionCost import — file:session-manager.ts:13
