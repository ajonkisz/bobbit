/**
 * Fun name generator for swarm agents.
 *
 * Picks a random name from a pre-generated pool of ~1700 short,
 * funny names stored in data/swarm-names.json. No API calls needed.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the name pool once at module init.
// Resolve from repo root: dist/server/agent/ -> ../../../data/swarm-names.json
let NAME_POOL: string[];
try {
	const poolPath = join(__dirname, "..", "..", "..", "data", "swarm-names.json");
	NAME_POOL = JSON.parse(readFileSync(poolPath, "utf-8"));
} catch {
	// Absolute fallback if the file is missing
	NAME_POOL = [
		"Ctrl+Z", "The Intern", "Bug Lebowski", "Darth Linter", "Null Pointer",
		"Greg from QA", "El Debuggador", "Syntax Sinatra", "404 Not Found",
		"Oops McFixit", "Fizzbuzz", "Glitch", "Spaghetti", "Wombat", "Biscuit",
		"Turbo Pascal", "Zero Cool", "Crash Override", "Scrambles", "Beans",
	];
}

// Track recently used names to avoid repeats within a server lifetime
const recentlyUsed = new Set<string>();
const MAX_RECENT = Math.min(Math.floor(NAME_POOL.length / 2), 500);

/**
 * Pick a random fun name for a swarm agent.
 * Role parameter is accepted for API compatibility but ignored —
 * all names are role-agnostic.
 */
export async function generateSwarmName(_role?: string): Promise<string> {
	return pickName();
}

function pickName(): string {
	// If we've exhausted our recent buffer, clear it
	if (recentlyUsed.size >= MAX_RECENT) {
		recentlyUsed.clear();
	}

	// Try to find a name not recently used
	for (let i = 0; i < 20; i++) {
		const name = NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
		if (!recentlyUsed.has(name)) {
			recentlyUsed.add(name);
			return name;
		}
	}

	// Fallback: just pick any random name
	return NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)];
}
