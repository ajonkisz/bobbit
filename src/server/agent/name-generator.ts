/**
 * Generates role-themed funny names for team agents using Claude Haiku.
 * Called when a new role is created; writes to data/team-names/<role>.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshOAuthToken } from "../auth/oauth.js";
import { piDir } from "../pi-dir.js";
import { invalidateRoleNameCache } from "./team-names.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NAMES_DIR = join(__dirname, "..", "..", "..", "data", "team-names");
const MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAuth(): AuthCredentials | null {
	const authPath = join(piDir(), "agent", "auth.json");
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

/**
 * Generate 50 funny, role-themed names and write them to data/team-names/<role>.json.
 * Fire-and-forget — failures are logged but don't block role creation.
 */
export async function generateRoleNames(roleName: string, roleLabel: string): Promise<void> {
	const outPath = join(NAMES_DIR, `${roleName}.json`);

	// Don't overwrite existing curated files
	if (existsSync(outPath)) {
		console.log(`[name-gen] Names file already exists for role "${roleName}", skipping`);
		return;
	}

	let auth = loadAuth();
	if (!auth) {
		console.error(`[name-gen] No auth available, cannot generate names for role "${roleName}"`);
		return;
	}

	// Refresh OAuth if expired
	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			console.error("[name-gen] Token expired and refresh failed");
			return;
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

	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. You generate funny names for AI coding agents.`
		: `You generate funny names for AI coding agents.`;

	const prompt = `Generate exactly 50 funny names for an AI agent whose role is "${roleLabel}" (id: "${roleName}").

Rules:
1. Each name must obviously feel like a name (human name, pet name, or nickname)
2. Keep them SHORT — max 3 words, ideally 1-2. We display these in a tight UI
3. Make them FUNNY — puns, pop culture references, wordplay, absurdist humour
4. Each name should be tangentially related to the "${roleLabel}" role
5. Mix styles: celebrity pun names, alliterative nicknames, "<Role thing> Mc<Thing>face" patterns, mashups

Example of excellent coding agent names: "JSON Derulo", "Lil Merge Conflict", "Boba Fetch", "Crash Bandicoder"

Output a JSON array of 50 strings. Output ONLY the JSON array, no explanation, no markdown fences.`;

	const body = {
		model: MODEL,
		max_tokens: 2048,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [{ role: "user", content: prompt }],
	};

	console.log(`[name-gen] Generating names for role "${roleName}" via ${MODEL}…`);

	try {
		const response = await fetch(API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[name-gen] API error ${response.status}: ${errText}`);
			return;
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) {
			console.error("[name-gen] Empty response");
			return;
		}

		// Parse the JSON array — strip markdown fences if present
		const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
		const names = JSON.parse(cleaned);

		if (!Array.isArray(names) || names.length === 0) {
			console.error("[name-gen] Response was not a valid array");
			return;
		}

		// Filter to only valid short strings
		const valid = names
			.filter((n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= 30)
			.slice(0, 50);

		if (valid.length < 10) {
			console.error(`[name-gen] Only ${valid.length} valid names generated, skipping`);
			return;
		}

		mkdirSync(NAMES_DIR, { recursive: true });
		writeFileSync(outPath, JSON.stringify(valid, null, 2) + "\n", "utf-8");
		invalidateRoleNameCache(roleName);

		console.log(`[name-gen] Wrote ${valid.length} names to ${outPath}`);
	} catch (err) {
		console.error("[name-gen] Failed:", err);
	}
}
