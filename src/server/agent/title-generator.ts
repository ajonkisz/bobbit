/**
 * Generates a short session title from conversation messages
 * using a lightweight Anthropic API call via Claude Haiku.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshOAuthToken } from "../auth/oauth.js";
import { globalAuthPath } from "../bobbit-dir.js";

const TITLE_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

interface AuthCredentials {
	type: string;
	access: string;
	refresh?: string;
	expires?: number;
}

function loadAuth(): AuthCredentials | null {
	const authPath = globalAuthPath();
	if (!existsSync(authPath)) {
		console.error("[title-gen] Auth file not found:", authPath);
		return null;
	}

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred) {
			console.error("[title-gen] No 'anthropic' key in auth.json");
			return null;
		}

		// Support both OAuth and API key auth
		if (cred.type === "oauth" && cred.access) {
			return cred;
		}
		if (cred.type === "api-key" && cred.key) {
			return { type: "api-key", access: cred.key };
		}

		console.error("[title-gen] Unrecognised auth type or missing credentials:", cred.type);
		return null;
	} catch (err) {
		console.error("[title-gen] Failed to read auth.json:", err);
		return null;
	}
}

/**
 * Extract text from agent messages for title generation.
 * Gathers the first few user and assistant messages.
 */
function extractConversationPreview(messages: any[]): string {
	const parts: string[] = [];
	let userCount = 0;
	let assistantCount = 0;
	const maxEach = 2;

	for (const msg of messages) {
		if (userCount >= maxEach && assistantCount >= maxEach) break;

		const role = msg.role;
		const isUser = role === "user" || role === "user-with-attachments";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) continue;
		if (isUser && userCount >= maxEach) continue;
		if (isAssistant && assistantCount >= maxEach) continue;

		let text = "";
		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			text = msg.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join(" ");
		}

		if (!text.trim()) continue;

		// Truncate individual messages
		const maxLen = 400;
		if (text.length > maxLen) text = text.slice(0, maxLen) + "…";

		const label = isUser ? "User" : "Assistant";
		parts.push(`${label}: ${text}`);

		if (isUser) userCount++;
		if (isAssistant) assistantCount++;
	}

	return parts.join("\n\n");
}

/**
 * Generate a short title for a session based on its messages.
 * Returns null if generation fails.
 */
export async function generateSessionTitle(messages: any[]): Promise<string | null> {
	let auth = loadAuth();
	if (!auth) return null;

	// If OAuth token is expired, try to refresh it
	if (auth.type === "oauth" && auth.expires && Date.now() > auth.expires) {
		const newToken = await refreshOAuthToken();
		if (newToken) {
			auth = { ...auth, access: newToken };
		} else {
			console.error("[title-gen] Token expired and refresh failed");
			return null;
		}
	}

	const preview = extractConversationPreview(messages);
	if (!preview.trim()) {
		console.error("[title-gen] No conversation content to summarise");
		return null;
	}

	// Build headers based on auth type
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

	const coreInstruction = "Output a 2-3 word label for this conversation. MAXIMUM 3 words. Examples: \"Fix Login Bug\", \"Redis Setup\", \"CSV Parser\", \"Dark Mode\". Output ONLY the label. No quotes, no markdown, no explanation. No emojis.";
	const systemText = auth.type === "oauth"
		? `You are Claude Code, Anthropic's official CLI for Claude. ${coreInstruction}`
		: coreInstruction;

	const body = {
		model: TITLE_MODEL,
		max_tokens: 12,
		system: auth.type === "oauth"
			? [{ type: "text", text: systemText }]
			: systemText,
		messages: [
			{
				role: "user",
				content: `Conversation:\n\n---\n${preview}\n---\n\n2-3 word label:`,
			},
		],
	};

	console.log(`[title-gen] Requesting title via ${TITLE_MODEL}…`);

	try {
		const response = await fetch(API_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] API error ${response.status}: ${errText}`);
			return null;
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) return null;

		// Clean up: remove surrounding quotes, markdown headers, limit length
		let title = text
			.replace(/^#+\s*/, "")           // strip markdown headers
			.replace(/^["'"']+|["'"']+$/g, "") // strip quotes
			.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{FE0F}]/gu, '') // strip emojis
			.replace(/\n.*/s, "")              // only first line
			.trim();
		if (title.length > 30) title = title.slice(0, 27) + "…";

		console.log(`[title-gen] Generated title: "${title}"`);
		return title || null;
	} catch (err) {
		console.error("[title-gen] Failed:", err);
		return null;
	}
}
