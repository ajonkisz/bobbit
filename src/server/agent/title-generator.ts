/**
 * Generates a short session title from conversation messages
 * using a lightweight Anthropic API call.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TITLE_MODEL = "claude-haiku-4-5-20250929";
const API_URL = "https://api.anthropic.com/v1/messages";

function getAccessToken(): string | null {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;

	try {
		const data = JSON.parse(readFileSync(authPath, "utf-8"));
		const cred = data.anthropic;
		if (!cred || cred.type !== "oauth" || !cred.access) return null;
		return cred.access;
	} catch {
		return null;
	}
}

/**
 * Extract text from agent messages for title generation.
 * Returns the first user message and first assistant response.
 */
function extractConversationPreview(messages: any[]): string {
	let userText = "";
	let assistantText = "";

	for (const msg of messages) {
		if (!userText && (msg.role === "user" || msg.role === "user-with-attachments")) {
			if (typeof msg.content === "string") {
				userText = msg.content;
			} else if (Array.isArray(msg.content)) {
				userText = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join(" ");
			}
		}

		if (!assistantText && msg.role === "assistant") {
			if (typeof msg.content === "string") {
				assistantText = msg.content;
			} else if (Array.isArray(msg.content)) {
				assistantText = msg.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join(" ");
			}
		}

		if (userText && assistantText) break;
	}

	// Truncate to keep the API call small
	const maxLen = 500;
	if (userText.length > maxLen) userText = userText.slice(0, maxLen) + "…";
	if (assistantText.length > maxLen) assistantText = assistantText.slice(0, maxLen) + "…";

	return `User: ${userText}\n\nAssistant: ${assistantText}`;
}

/**
 * Generate a short title for a session based on its messages.
 * Returns null if generation fails.
 */
export async function generateSessionTitle(messages: any[]): Promise<string | null> {
	const token = getAccessToken();
	if (!token) {
		console.error("[title-gen] No OAuth access token available");
		return null;
	}

	const preview = extractConversationPreview(messages);
	if (!preview.trim() || preview === "User: \n\nAssistant: ") {
		return null;
	}

	try {
		const response = await fetch(API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				// OAuth tokens use Bearer auth, not x-api-key
				"Authorization": `Bearer ${token}`,
				"anthropic-version": "2023-06-01",
				// Required beta headers for OAuth access
				"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			},
			body: JSON.stringify({
				model: TITLE_MODEL,
				max_tokens: 30,
				// OAuth tokens require Claude Code identity in system prompt
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude. Generate a very short title (3-7 words, no quotes) summarizing the conversation you are shown.",
					},
				],
				messages: [
					{
						role: "user",
						content: preview,
					},
				],
			}),
		});

		if (!response.ok) {
			const errText = await response.text();
			console.error(`[title-gen] API error ${response.status}: ${errText}`);
			return null;
		}

		const data = await response.json() as {
			content: Array<{ type: string; text?: string }>;
		};

		const text = data.content
			?.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("")
			.trim();

		if (!text) return null;

		// Clean up: remove surrounding quotes if present, limit length
		let title = text.replace(/^["'"']+|["'"']+$/g, "").trim();
		if (title.length > 60) title = title.slice(0, 57) + "…";

		return title || null;
	} catch (err) {
		console.error("[title-gen] Failed:", err);
		return null;
	}
}
