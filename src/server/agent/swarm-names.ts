/**
 * Fun name generator for swarm agents.
 *
 * Each role gets thematic first names and surnames that hint at what
 * the role does, producing names like:
 *   Team Lead: Bobby Champion
 *   Coder: Jimmy Fixer
 *   Reviewer: Sherlock Findabug
 *   Tester: Tessa Breakit
 */

const FIRST_NAMES: Record<string, string[]> = {
	"team-lead": [
		"Bobby", "Captain", "Major", "Admiral", "General",
		"Chief", "Duke", "Rex", "Ace", "Max",
		"Boss", "Sterling", "Magnus", "Atlas", "Maverick",
	],
	coder: [
		"Jimmy", "Chip", "Pixel", "Byte", "Kit",
		"Cody", "Dev", "Dash", "Sparky", "Blaze",
		"Rocky", "Flash", "Turbo", "Rusty", "Clyde",
	],
	reviewer: [
		"Sherlock", "Inspector", "Detective", "Eagle", "Hawk",
		"Lynx", "Argus", "Scout", "Sage", "Raven",
		"Radar", "Keen", "Vigil", "Artemis", "Iris",
	],
	tester: [
		"Tessa", "Crash", "Buster", "Smash", "Boom",
		"Spike", "Nitro", "Bolt", "Havoc", "Blitz",
		"Hammer", "Tank", "Ricochet", "Storm", "Fury",
	],
};

const SURNAMES: Record<string, string[]> = {
	"team-lead": [
		"Champion", "Leadwell", "Plansworth", "Braveheart", "Commanderson",
		"Flagship", "Victory", "Stratego", "Trailblaze", "Helmsworth",
		"Rallyton", "Vanguard", "Ironwill", "Steadfast", "Pinnacle",
	],
	coder: [
		"Fixer", "Codewright", "Hackwell", "Buildmore", "Craftsman",
		"Stackwell", "Loopsmith", "Refactor", "Semicolon", "Compiler",
		"Debugson", "Patchwork", "Bitwise", "Mergebright", "Pushington",
	],
	reviewer: [
		"Findabug", "Nitpick", "Hawkeye", "Peepcode", "Lookhard",
		"Scanwell", "Spyglass", "Scrutiny", "Sharpread", "Gotcha",
		"Watchful", "Diligent", "Proofwell", "Catchall", "Seethrough",
	],
	tester: [
		"Breakit", "Crashwell", "Failsafe", "Assertson", "Checkmate",
		"Edgecase", "Stresstest", "Mockwell", "Bugfinder", "Greenbar",
		"Redlight", "Timeout", "Segfault", "Benchmark", "Smoketest",
	],
};

/** Fallback lists for unknown roles. */
const GENERIC_FIRST = [
	"Agent", "Buddy", "Zippy", "Sparks", "Dynamo",
	"Blip", "Cosmo", "Neon", "Quark", "Zephyr",
];
const GENERIC_LAST = [
	"McTaskface", "Workhorse", "Goalgetter", "Hustleton", "Grindstone",
	"Busybee", "Hotfix", "Overdrive", "Crunchtime", "Shipwright",
];

/**
 * Generate a fun name for a swarm agent given its role.
 * Names are random — no uniqueness guarantee, but the pool is large enough
 * that collisions within a single swarm are unlikely.
 */
export function generateSwarmName(role: string): string {
	const firsts = FIRST_NAMES[role] ?? GENERIC_FIRST;
	const lasts = SURNAMES[role] ?? GENERIC_LAST;
	const first = firsts[Math.floor(Math.random() * firsts.length)];
	const last = lasts[Math.floor(Math.random() * lasts.length)];
	return `${first} ${last}`;
}
