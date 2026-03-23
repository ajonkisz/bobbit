/**
 * Skill definitions sync.
 *
 * The server is the canonical source of skill definitions.
 * On startup it writes them to a well-known JSON file so the
 * agent-side tool extension can discover them without duplication.
 *
 * Path: ~/.pi/skill-definitions.json
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import { listSkills } from "./registry.js";

export const SKILL_DEFINITIONS_PATH = path.join(bobbitStateDir(), "skill-definitions.json");

/**
 * Write all registered skill definitions to disk.
 * Call this after all skills have been registered (server startup).
 */
export function exportSkillDefinitions(): void {
	const skills = listSkills();
	const data = {
		version: 1,
		exportedAt: Date.now(),
		skills: skills.map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description,
			isolation: s.isolation,
			expectedOutput: s.expectedOutput,
			timeoutMs: s.timeoutMs,
		})),
	};
	fs.mkdirSync(path.dirname(SKILL_DEFINITIONS_PATH), { recursive: true });
	fs.writeFileSync(SKILL_DEFINITIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
	console.log(`[skills] Exported ${skills.length} skill definitions to ${SKILL_DEFINITIONS_PATH}`);
}
