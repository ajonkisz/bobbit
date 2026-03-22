/**
 * Validates content for workflow artifacts with `format: command`.
 *
 * These artifacts have their content substituted directly into `{{command}}`
 * in verification shell scripts, so the content must be a raw, executable
 * shell command — not markdown, not prose, not a document.
 */

export interface CommandValidationResult {
	valid: boolean;
	reason?: string;
}

/** Prefixes that indicate a line is likely a shell command. */
const COMMAND_PREFIXES = [
	"npm", "npx", "node", "git", "cd", "bash", "sh", "python", "pip",
	"cargo", "make", "docker", "curl", "wget", "cat", "echo", "export",
	"set", "mkdir", "rm", "cp", "mv", "ls", "find", "grep", "sed", "awk",
	"test", "[",
];

/** Shell operators that indicate a line is part of a command. */
const SHELL_OPERATOR_RE = /[|]{1,2}|&&|;|>{1,2}|2>|\$\(/;

function looksLikeShellCommand(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;

	// Starts with a known command prefix (word boundary)
	for (const prefix of COMMAND_PREFIXES) {
		if (trimmed === prefix || trimmed.startsWith(prefix + " ") || trimmed.startsWith(prefix + "\t")) {
			return true;
		}
	}

	// Starts with path execution
	if (trimmed.startsWith("./") || trimmed.startsWith("/")) return true;

	// Starts with env var assignment (e.g. FOO=bar command)
	if (/^[A-Z_][A-Z0-9_]*=/.test(trimmed)) return true;

	// Contains shell operators
	if (SHELL_OPERATOR_RE.test(trimmed)) return true;

	// Line continuation backslash (part of a multi-line command)
	if (trimmed.endsWith("\\")) return true;

	return false;
}

export function validateCommandArtifact(content: string): CommandValidationResult {
	// 1. Empty / whitespace-only
	if (!content || !content.trim()) {
		return { valid: false, reason: "Content is empty. Must be a raw shell command." };
	}

	// 2. Contains markdown code fences
	if (content.includes("```")) {
		return {
			valid: false,
			reason: "Contains markdown code fences (```). Remove the fences and submit just the raw command.",
		};
	}

	// 3. Starts with markdown heading
	if (content.trimStart().startsWith("# ")) {
		return {
			valid: false,
			reason: "Starts with a markdown heading. Must be a raw shell command, not a document.",
		};
	}

	// 4. Multi-paragraph prose heuristic
	const lines = content.split("\n").filter(l => l.trim().length > 0);
	if (lines.length > 5) {
		const commandLines = lines.filter(looksLikeShellCommand).length;
		if (commandLines < lines.length / 2) {
			return {
				valid: false,
				reason: "Content appears to be prose/documentation rather than a shell command.",
			};
		}
	}

	return { valid: true };
}
