/**
 * Skills module — barrel export + auto-registration of built-in skills.
 */

export type { Skill } from "./types.js";
export { registerSkill, getSkill, listSkills } from "./registry.js";
export { runSkillAgent, runSkillAgentsParallel, createSkillRequest } from "./sub-agent.js";
export type { SkillInvocationRequest, SkillInvocationResult } from "./sub-agent.js";
export { exportSkillDefinitions, SKILL_DEFINITIONS_PATH } from "./definitions-sync.js";

// Register built-in skill definitions
import { registerSkill } from "./registry.js";
import { correctnessReview, securityReview, designReview } from "./definitions/code-review.js";
import { testSuiteReportSkill } from "./definitions/test-suite-report.js";

registerSkill(correctnessReview);
registerSkill(securityReview);
registerSkill(designReview);
registerSkill(testSuiteReportSkill);
