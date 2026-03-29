import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const PROMPTS_DIR = path.join(bobbitStateDir(), "session-prompts");

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

/**
 * Parse YAML frontmatter from a Claude Code memory file.
 * Returns extracted fields and body content, or null if invalid.
 */
export function parseMemoryFile(content: string): { name: string; description: string; type: string; body: string } | null {
	if (!content.startsWith('---')) return null;
	const endIdx = content.indexOf('\n---', 3);
	if (endIdx === -1) return null;
	const frontmatter = content.slice(3, endIdx);
	const body = content.slice(endIdx + 4).trim();
	const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || '';
	const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
	const type = frontmatter.match(/^type:\s*(.+)$/m)?.[1]?.trim() || '';
	return { name, description, type, body };
}

/**
 * Read CLAUDE.md from a directory, resolving `@` references.
 * Returns empty string if not found or if content is just `@AGENTS.md` (dedup).
 */
export function readClaudeMd(cwd: string): string {
	const claudePath = path.join(cwd, "CLAUDE.md");
	if (!fs.existsSync(claudePath)) return "";

	try {
		const raw = fs.readFileSync(claudePath, "utf-8");
		// Skip if CLAUDE.md is just a reference to AGENTS.md (avoid duplication)
		if (raw.trim() === "@AGENTS.md") return "";
		return resolveMarkdownRefs(raw, cwd);
	} catch {
		return "";
	}
}

/**
 * Read Claude Code project memory files from ~/.claude/projects/{encodedCwd}/memory/*.md.
 * Returns a formatted section string, or empty string if no memories found.
 */
export function readClaudeCodeMemories(cwd: string): string {
	try {
		const encodedCwd = cwd.replace(/\//g, "-");
		const memoryDir = path.join(os.homedir(), ".claude", "projects", encodedCwd, "memory");

		if (!fs.existsSync(memoryDir)) return "";

		const files = fs.readdirSync(memoryDir)
			.filter(f => f.endsWith(".md") && f !== "MEMORY.md")
			.sort()
			.slice(0, 20);

		if (files.length === 0) return "";

		const allowedTypes = new Set(["user", "feedback", "project"]);
		const parts: string[] = [];
		let totalLength = 0;

		for (const file of files) {
			try {
				const content = fs.readFileSync(path.join(memoryDir, file), "utf-8");
				const parsed = parseMemoryFile(content);
				if (!parsed || !allowedTypes.has(parsed.type)) continue;

				const entry = `### ${parsed.name}\n\n${parsed.body}`;
				if (totalLength + entry.length > 16000) break;
				parts.push(entry);
				totalLength += entry.length;
			} catch {
				// Skip unreadable files
			}
		}

		if (parts.length === 0) return "";
		return "# Claude Code Project Memories\n\n" + parts.join("\n\n");
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
	/** Role prompt template (separate from goalSpec for section display) */
	rolePrompt?: string;
	/** Role name for display */
	roleName?: string;
	/** Tool restrictions text (separate from goalSpec for section display) */
	toolRestrictions?: string;
	/** Task title */
	taskTitle?: string;
	/** Task type (e.g. 'implementation', 'code-review', etc.) */
	taskType?: string;
	/** Task spec markdown content */
	taskSpec?: string;
	/** Human-readable descriptions of dependency tasks */
	taskDependsOn?: string[];
	/** Personalities to inject into the system prompt */
	personalities?: Array<{ label: string; promptFragment: string }>;
	/** Pre-formatted tool documentation section to append */
	toolDocs?: string;
	/** Allowed tool names for this session — used to filter tool docs */
	allowedTools?: string[];
	/** Pre-formatted upstream gate context from workflow dependencies */
	workflowContext?: string;
}

export interface PromptSection {
	label: string;
	source: string;
	content: string;
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

	// 2.5. CLAUDE.md from working directory
	const claudeMd = readClaudeMd(parts.cwd);
	if (claudeMd.trim()) {
		if (agentsMd.trim()) {
			// Merge into the existing Project Context section
			sections[sections.length - 1] = "# Project Context\n\n" + agentsMd.trim() + "\n\n" + claudeMd.trim();
		} else {
			sections.push("# Project Context\n\n" + claudeMd.trim());
		}
	}

	// 2.7. Claude Code project memories
	const memories = readClaudeCodeMemories(parts.cwd);
	if (memories.trim()) {
		sections.push(memories);
	}

	// 3. Goal spec (merge rolePrompt and toolRestrictions into goalSpec section for backward compat)
	{
		let effectiveGoalSpec = parts.goalSpec || "";
		if (parts.rolePrompt?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.rolePrompt.trim();
		}
		if (parts.toolRestrictions?.trim()) {
			effectiveGoalSpec = (effectiveGoalSpec ? effectiveGoalSpec + "\n\n---\n\n" : "") + parts.toolRestrictions.trim();
		}
		if (effectiveGoalSpec.trim()) {
			const header = parts.goalTitle
				? `# Goal\n\n**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
				: "# Goal";
			sections.push(header + "\n\n" + effectiveGoalSpec.trim());
		}
	}

	// 3.5. Personalities
	if (parts.personalities && parts.personalities.length > 0) {
		const lines = ["## Personality\n", "You should embody these personalities in how you work:"];
		for (const personality of parts.personalities) {
			lines.push(`- **${personality.label}**: ${personality.promptFragment}`);
		}
		sections.push(lines.join("\n"));
	}

	// 4. Tool documentation
	if (parts.toolDocs?.trim()) {
		sections.push(parts.toolDocs.trim());
	}

	// 5. Task context
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = ["# Current Task"];
		if (parts.taskType) taskLines.push(`\n**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);

		if (parts.taskSpec?.trim()) {
			taskLines.push(`\n## Task Specification\n${parts.taskSpec.trim()}`);
		}

		if (parts.taskDependsOn && parts.taskDependsOn.length > 0) {
			taskLines.push("\n## Dependencies\nThis task depends on the following completed tasks:");
			for (const dep of parts.taskDependsOn) {
				taskLines.push(`- ${dep}`);
			}
		}

		sections.push(taskLines.join("\n"));
	}

	// 6. Workflow dependency context (accepted upstream gate content)
	if (parts.workflowContext?.trim()) {
		sections.push(parts.workflowContext.trim());
	}

	if (sections.length === 0) return undefined;

	const combined = sections.join("\n\n---\n\n") + "\n";

	const promptPath = path.join(PROMPTS_DIR, `${sessionId}.md`);
	fs.writeFileSync(promptPath, combined, "utf-8");
	return promptPath;
}

/**
 * Return the system prompt broken into labeled sections for the inspector UI.
 * Takes the same PromptParts as assembleSystemPrompt but returns structured
 * sections instead of writing to disk.
 */
export function getPromptSections(parts: PromptParts): PromptSection[] {
	const sections: PromptSection[] = [];

	// 1. Global system prompt
	if (parts.baseSystemPromptPath && fs.existsSync(parts.baseSystemPromptPath)) {
		const base = fs.readFileSync(parts.baseSystemPromptPath, "utf-8").trim();
		if (base) sections.push({ label: "System Prompt", source: "config/system-prompt.md", content: base });
	}

	// 2. AGENTS.md
	const agentsMd = readAgentsMd(parts.cwd);
	if (agentsMd.trim()) sections.push({ label: "Project Context", source: "AGENTS.md", content: agentsMd.trim() });

	// 2.5. CLAUDE.md
	const claudeMd = readClaudeMd(parts.cwd);
	if (claudeMd.trim()) {
		sections.push({ label: "CLAUDE.md", source: "CLAUDE.md", content: claudeMd.trim() });
	}

	// 2.7. Claude Code memories
	const memoriesContent = readClaudeCodeMemories(parts.cwd);
	if (memoriesContent.trim()) {
		sections.push({ label: "Claude Code Memories", source: "~/.claude/projects/.../memory/", content: memoriesContent.trim() });
	}

	// 3. Goal spec (separate from role)
	if (parts.goalSpec?.trim()) {
		const header = parts.goalTitle
			? `**${parts.goalTitle}** (Status: ${parts.goalState || "unknown"})`
			: "";
		sections.push({ label: "Goal", source: `Goal: ${parts.goalTitle || "Untitled"}`, content: (header ? header + "\n\n" : "") + parts.goalSpec.trim() });
	}

	// 4. Role prompt
	if (parts.rolePrompt?.trim()) {
		sections.push({ label: "Role", source: `Role: ${parts.roleName || "unknown"}`, content: parts.rolePrompt.trim() });
	}

	// 5. Tool restrictions
	if (parts.toolRestrictions?.trim()) {
		sections.push({ label: "Tool Restrictions", source: "Allowed tools filter", content: parts.toolRestrictions.trim() });
	}

	// 6. Personalities
	if (parts.personalities && parts.personalities.length > 0) {
		const lines = parts.personalities.map(p => `- **${p.label}**: ${p.promptFragment}`);
		sections.push({ label: "Personality", source: "Personalities", content: lines.join("\n") });
	}

	// 7. Tool docs
	if (parts.toolDocs?.trim()) {
		sections.push({ label: "Tools", source: "Tool documentation", content: parts.toolDocs.trim() });
	}

	// 8. Task context
	if (parts.taskTitle || parts.taskType) {
		const taskLines: string[] = [];
		if (parts.taskType) taskLines.push(`**Type**: ${parts.taskType}`);
		if (parts.taskTitle) taskLines.push(`**Title**: ${parts.taskTitle}`);
		if (parts.taskSpec?.trim()) taskLines.push(`\n## Task Specification\n${parts.taskSpec.trim()}`);
		if (parts.taskDependsOn?.length) {
			taskLines.push("\n## Dependencies");
			for (const dep of parts.taskDependsOn) taskLines.push(`- ${dep}`);
		}
		sections.push({ label: "Task", source: `Task: ${parts.taskTitle || "Untitled"}`, content: taskLines.join("\n") });
	}

	// 9. Workflow context
	if (parts.workflowContext?.trim()) {
		sections.push({ label: "Workflow Context", source: "Upstream gates", content: parts.workflowContext.trim() });
	}

	return sections;
}

/**
 * Clean up a session's assembled prompt file.
 */
export function cleanupSessionPrompt(sessionId: string): void {
	const promptPath = path.join(PROMPTS_DIR, `${sessionId}.md`);
	try {
		if (fs.existsSync(promptPath)) fs.unlinkSync(promptPath);
	} catch { /* ignore */ }
	// Also clean up per-session preview file
	const previewPath = path.join(bobbitStateDir(), `preview-${sessionId}.html`);
	try {
		if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
	} catch { /* ignore */ }
}
