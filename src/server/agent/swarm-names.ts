/**
 * Fun name generator for swarm agents.
 *
 * Uses Claude Haiku to generate a creative, memorable two-word name
 * that fits the agent's role. Falls back to random selection from
 * hardcoded pools if the API call fails.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshOAuthToken } from "../auth/oauth.js";

const NAME_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAuth(): AuthCredentials | null {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) return null;
		if (cred.type === "oauth" && cred.access) return cred;
		if (cred.type === "api-key" && cred.key) return { type: "api-key", access: cred.key };
		return null;
	} catch {
		return null;
	}
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
	"team-lead": "a team lead who plans, delegates, and coordinates work",
	coder: "a coder who implements features and fixes bugs",
	reviewer: "a code reviewer who scrutinizes code for bugs and design issues",
	tester: "a tester who writes and runs tests to break things",
};

/**
 * Generate a fun name for a swarm agent using Claude Haiku.
 * Returns a two-word character name like "Bobby Champion" or "Sherlock Findabug".
 * Falls back to random hardcoded names if the API call fails.
 */
export async function generateSwarmName(role: string): Promise<string> {
	try {
		const name = await generateNameViaHaiku(role);
		if (name) return name;
	} catch (err) {
		console.error("[swarm-names] Haiku generation failed, using fallback:", err);
	}
	return randomFallbackName(role);
}

async function generateNameViaHaiku(role: string): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	// Refresh expired OAuth tokens
	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			return null;
		}
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};

	if (auth.type === "oauth") {
		headers["Authorization"] = `Bearer ${auth.access}`;
		headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
	} else {
		headers["x-api-key"] = auth.access;
	}

	const roleDesc = ROLE_DESCRIPTIONS[role] ?? `an agent with the role "${role}"`;

	const coreInstruction = [
		`Invent a fun, memorable two-word character name for ${roleDesc}.`,
		"The name should be a first name and a punny/thematic surname that hints at what they do.",
		'Examples for different roles: "Bobby Champion", "Jimmy Fixer", "Sherlock Findabug", "Tessa Breakit", "Captain Plansworth", "Pixel Loopsmith", "Eagle Gotcha", "Crash Edgecase".',
		"Be creative — avoid reusing the examples above. Each name should feel unique and fun.",
		"Output ONLY the two-word name. No quotes, no explanation, no punctuation.",
	].join(" ");

	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${coreInstruction}`
		: coreInstruction;

	const body = {
		model: NAME_MODEL,
		max_tokens: 12,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{
				role: "user",
				content: `Generate a fun two-word name for a ${role} agent:`,
			},
		],
	};

	const response = await fetch(API_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	if (!response.ok) return null;

	const data = (await response.json()) as {
		content: Array<{ type: string; text?: string }>;
	};

	const text = data.content
		?.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("")
		.trim();

	if (!text) return null;

	// Clean up: remove quotes, keep only first line, limit to ~30 chars
	let name = text
		.replace(/^["'"']+|["'"']+$/g, "")
		.replace(/\n.*/s, "")
		.trim();

	// Validate it looks like a two-word name
	const words = name.split(/\s+/);
	if (words.length < 2 || words.length > 3) return null;
	if (name.length > 30) name = name.slice(0, 30).trim();

	console.log(`[swarm-names] Generated name for ${role}: "${name}"`);
	return name;
}

// ---- Fallback random names ----

const FALLBACK_FIRST: Record<string, string[]> = {
	"team-lead": ["Bobby", "Captain", "Major", "Admiral", "Chief", "Duke", "Rex", "Ace", "Sterling", "Maverick"],
	coder: ["Jimmy", "Chip", "Pixel", "Byte", "Cody", "Dash", "Sparky", "Flash", "Turbo", "Rusty"],
	reviewer: ["Sherlock", "Inspector", "Eagle", "Hawk", "Lynx", "Argus", "Scout", "Sage", "Keen", "Vigil"],
	tester: ["Tessa", "Crash", "Buster", "Smash", "Spike", "Nitro", "Bolt", "Havoc", "Blitz", "Hammer"],
};

const FALLBACK_LAST: Record<string, string[]> = {
	"team-lead": ["Champion", "Leadwell", "Plansworth", "Braveheart", "Flagship", "Victory", "Vanguard", "Ironwill", "Steadfast", "Pinnacle"],
	coder: ["Fixer", "Codewright", "Hackwell", "Buildmore", "Loopsmith", "Refactor", "Compiler", "Debugson", "Patchwork", "Pushington"],
	reviewer: ["Findabug", "Nitpick", "Hawkeye", "Peepcode", "Scanwell", "Scrutiny", "Sharpread", "Gotcha", "Watchful", "Catchall"],
	tester: ["Breakit", "Crashwell", "Failsafe", "Assertson", "Checkmate", "Edgecase", "Stresstest", "Bugfinder", "Greenbar", "Smoketest"],
};

const GENERIC_FIRST = ["Agent", "Buddy", "Zippy", "Sparks", "Dynamo", "Blip", "Cosmo", "Neon", "Quark", "Zephyr"];
const GENERIC_LAST = ["McTaskface", "Workhorse", "Goalgetter", "Hustleton", "Grindstone", "Hotfix", "Overdrive", "Crunchtime", "Shipwright", "Busybee"];

function randomFallbackName(role: string): string {
	const firsts = FALLBACK_FIRST[role] ?? GENERIC_FIRST;
	const lasts = FALLBACK_LAST[role] ?? GENERIC_LAST;
	const first = firsts[Math.floor(Math.random() * firsts.length)];
	const last = lasts[Math.floor(Math.random() * lasts.length)];
	return `${first} ${last}`;
}
