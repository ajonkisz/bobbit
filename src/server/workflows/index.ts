export type { Workflow, Phase, WorkflowState, WorkflowArtifact, PhaseRecord } from "./types.js";
export { registerWorkflow, getWorkflow, listWorkflows } from "./registry.js";
export { WorkflowRunner } from "./engine.js";
export { storeArtifact, readArtifact, listArtifactFiles, cleanupArtifacts } from "./artifact-store.js";
export { generateReport } from "./report.js";
export { createWorktree, cleanupWorktree } from "./git.js";
export { exportDefinitions, DEFINITIONS_PATH } from "./definitions-sync.js";
export { runSubAgent, runSubAgentsParallel, createSubAgentRequest } from "./sub-agent.js";
export type { SubAgentRequest, SubAgentResult } from "./sub-agent.js";

// Register built-in workflow definitions
import { registerWorkflow } from "./registry.js";
import { testSuiteReport } from "./definitions/test-suite-report.js";
import { codeReview } from "./definitions/code-review.js";

registerWorkflow(testSuiteReport);
registerWorkflow(codeReview);
