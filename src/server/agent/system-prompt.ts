import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROMPTS_DIR = path.join(os.homedir(), ".pi", "session-prompts");

// Ensure prompts directory exists
if (!fs.existsSync(PROMPTS_DIR)) {
	fs.mkdirSync(PROMPTS_DIR, { recursive: true });
}

/**
 * Resolve `@FILENAME.md` references in markdown content.
 *
 * Lines matching `@somefile.md` (optionally with leading whitespace) are
 * replaced with the contents of that file, resolved relative to `baseDir`.
 * References are resolved recursively (a referenced file can itself contain
 * `@` references). A `seen` set prevents infinite loops.
 */
export function resolveMarkdownRefs(content: string, baseDir: string, seen?: Set<string>): string {
	if (!seen) seen = new Set();

	return content.replace(/^([ \t]*)@(\S+\.md)\s*$/gm, (_match, indent: string, filename: string) => {
		const filePath = path.resolve(baseDir, filename);
		const canonical = path.normalize(filePath);

		if (seen!.has(canonical)) {
			return `${indent}<!-- circular reference: ${filename} -->`;
		}

		if (!fs.existsSync(filePath)) {
			return `${indent}<!-- file not found: ${filename} -->`;
		}

		seen!.add(canonical);
		try {
			const refContent = fs.readFileSync(filePath, "utf-8");
			const resolved = resolveMarkdownRefs(refContent, path.dirname(filePath), seen);
			// Preserve indentation for each line of the included content
			if (indent) {
				return resolved
					.split("\n")
					.map((line) => (line.trim() ? indent + line : line))
					.join("\n");
			}
			return resolved;
		} catch {
			return `${indent}<!-- error reading: ${filename} -->`;
		}
	});
}

/**
 * Read an AGENTS.md file from a directory, resolving `@` references.
 * Returns the resolved content, or empty string if no file exists.
 * Looks for AGENTS.md (case-sensitive).
 */
export function readAgentsMd(cwd: string): string {
	const agentsPath = path.join(cwd, "AGENTS.md");
	if (!fs.existsSync(agentsPath)) return "";

	try {
		const raw = fs.readFileSync(agentsPath, "utf-8");
		return resolveMarkdownRefs(raw, cwd);
	} catch {
		return "";
	}
}

export interface PromptParts {
	/** Path to the global system prompt file (config/system-prompt.md) */
	baseSystemPromptPath?: string;
	/** Working directory for the session — used to find AGENTS.md */
	cwd: string;
	/** Goal title (for header) */
	goalTitle?: string;
	/** Goal state */
	goalState?: string;
	/** Goal spec markdown content */
	goalSpec?: string;
}

/**
 * Assemble the full system prompt from its parts and write to a temp file.
 *
 * Order:
 *   1. Global system prompt (config/system-prompt.md)
 *   2. AGENTS.md from the session's working directory (with @refs resolved inline)
 *   3. Goal spec (if session belongs to a goal)
 *
 * Returns the path to the assembled prompt file, or undefined if all parts
 * are empty (in which case no --system-prompt should be passed to the agent).
 */
export function assembleSystemPrompt(sessionId: string, parts: PromptParts): string | undefined {
	const sections: string[] = [];

	// 1. Global system prompt
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const base = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		if (base) sections.push(base);
	}

	// 2. AGENTS.md from working directory
	const agentsMd = readAgentsMd(parts.cwd);
	if (agentsMd.trim()) {
		sections.push("# Project Context\n\n" + agentsMd.trim());
	}

	// 3. Goal spec
	if (parts.goalSpec?.trim()) {
		const header = parts.goalTitle
			? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "# Goal";
		sections.push(header + "\n\n" + parts.goalSpec.trim());
	}

	if (sections.length === 0) return undefined;

	const combined = sections.join("\n\n---\n\n") + "\n";

	const promptPath = path.join(PROMPTS_DIR, `${sessionId}.md`);
	fs.writeFileSync(promptPath, combined, "utf-8");
	return promptPath;
}

/**
 * Clean up a session's assembled prompt file.
 */
export function cleanupSessionPrompt(sessionId: string): void {
	const promptPath = path.join(PROMPTS_DIR, `${sessionId}.md`);
	try {
		if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
	} catch { /* ignore */ }
}
