export type { Workflow, Phase, WorkflowState, WorkflowArtifact, PhaseRecord } from "./types.js";
export { registerWorkflow, getWorkflow, listWorkflows } from "./registry.js";
export { WorkflowRunner } from "./engine.js";
export { storeArtifact, readArtifact, listArtifactFiles, cleanupArtifacts } from "./artifact-store.js";
export { generateReport } from "./report.js";
export { createWorktree, cleanupWorktree } from "./git.js";

// Register built-in workflow definitions
import { registerWorkflow } from "./registry.js";
import { testSuiteReport } from "./definitions/test-suite-report.js";

registerWorkflow(testSuiteReport);
