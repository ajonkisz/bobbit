## Backlog
- [ ] #4 Review all changes — role:reviewer, depends:#1,#2,#3
- [ ] #5 Update swarm-prompts.test.ts assertions for new API-based prompts — role:tester, depends:#2
- [ ] #6 Review env vars pass-through in spawnRole() — role:reviewer, depends:#1, branch:goal-swarm-task-1-env-vars
- [ ] #7 Test env vars pass-through in spawnRole() — role:tester, depends:#1

## In Progress
- [x] #2 Rewrite swarm prompts to use Task REST API instead of TASKS.md — role:coder, claimed-by:coder-d7bd2c6b
- [x] #3 Add event-driven steer notifications in SwarmManager when workers go idle (agent_end) — role:coder, claimed-by:coder-38c1d000

## Done
- [x] #1 Pass env vars (BOBBIT_GATEWAY_URL, BOBBIT_AUTH_TOKEN, BOBBIT_GOAL_ID, BOBBIT_SESSION_ID) to worker sessions in spawnRole() — role:coder, completed-by:coder-09fee49e

## Findings
