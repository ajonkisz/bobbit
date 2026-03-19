/**
 * Skill registry.
 *
 * In-memory store of skill definitions. Skills are registered at import time
 * and looked up by ID when invoked.
 */

import type { Skill } from "./types.js";

const skills = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
	skills.set(skill.id, skill);
}

export function getSkill(id: string): Skill | undefined {
	return skills.get(id);
}

export function listSkills(): Skill[] {
	return Array.from(skills.values());
}
