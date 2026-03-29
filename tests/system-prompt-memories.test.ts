/**
 * Unit tests for Claude Code Memory Bridge — parseMemoryFile, readClaudeMd, readClaudeCodeMemories.
 * Uses temp directories for all fixtures. Cleans up after each test.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up temp BOBBIT_DIR before importing the module
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mem-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(path.join(stateDir, "session-prompts"), { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { parseMemoryFile, readClaudeMd, readClaudeCodeMemories } = await import(
	"../src/server/agent/system-prompt.ts"
);

// ---------------------------------------------------------------------------
// parseMemoryFile
// ---------------------------------------------------------------------------

describe("parseMemoryFile", () => {
	it("parses valid frontmatter with body", () => {
		const content = "---\nname: Test Memory\ndescription: A test\ntype: user\n---\nBody content here";
		const result = parseMemoryFile(content);
		assert.ok(result);
		assert.strictEqual(result.name, "Test Memory");
		assert.strictEqual(result.description, "A test");
		assert.strictEqual(result.type, "user");
		assert.strictEqual(result.body, "Body content here");
	});

	it("returns null for content without frontmatter", () => {
		const result = parseMemoryFile("Just plain text\nNo frontmatter here");
		assert.strictEqual(result, null);
	});

	it("returns null when closing --- is missing", () => {
		const result = parseMemoryFile("---\nname: Test\nBody without closing");
		assert.strictEqual(result, null);
	});

	it("returns empty string for missing type field", () => {
		const content = "---\nname: NoType\ndescription: Desc\n---\nSome body";
		const result = parseMemoryFile(content);
		assert.ok(result);
		assert.strictEqual(result.name, "NoType");
		assert.strictEqual(result.type, "");
		assert.strictEqual(result.body, "Some body");
	});

	it("returns empty body when frontmatter has no trailing content", () => {
		const content = "---\nname: Empty\ndescription: Nothing\ntype: project\n---";
		const result = parseMemoryFile(content);
		assert.ok(result);
		assert.strictEqual(result.name, "Empty");
		assert.strictEqual(result.type, "project");
		assert.strictEqual(result.body, "");
	});
});

// ---------------------------------------------------------------------------
// readClaudeMd
// ---------------------------------------------------------------------------

describe("readClaudeMd", () => {
	let cwdDir: string;

	beforeEach(() => {
		cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-claude-md-"));
	});

	afterEach(() => {
		fs.rmSync(cwdDir, { recursive: true, force: true });
	});

	it("reads normal CLAUDE.md content", () => {
		fs.writeFileSync(path.join(cwdDir, "CLAUDE.md"), "# My Project\n\nCustom instructions.", "utf-8");
		const result = readClaudeMd(cwdDir);
		assert.ok(result.includes("# My Project"));
		assert.ok(result.includes("Custom instructions."));
	});

	it("returns empty string when CLAUDE.md is just @AGENTS.md", () => {
		fs.writeFileSync(path.join(cwdDir, "CLAUDE.md"), "@AGENTS.md", "utf-8");
		const result = readClaudeMd(cwdDir);
		assert.strictEqual(result, "");
	});

	it("returns empty string when CLAUDE.md is @AGENTS.md with whitespace", () => {
		fs.writeFileSync(path.join(cwdDir, "CLAUDE.md"), "  @AGENTS.md  \n", "utf-8");
		const result = readClaudeMd(cwdDir);
		assert.strictEqual(result, "");
	});

	it("returns empty string when no CLAUDE.md exists", () => {
		const result = readClaudeMd(cwdDir);
		assert.strictEqual(result, "");
	});

	it("resolves @ references in CLAUDE.md", () => {
		fs.writeFileSync(path.join(cwdDir, "CLAUDE.md"), "Header\n@other.md\nFooter", "utf-8");
		fs.writeFileSync(path.join(cwdDir, "other.md"), "Included content", "utf-8");
		const result = readClaudeMd(cwdDir);
		assert.ok(result.includes("Header"));
		assert.ok(result.includes("Included content"));
		assert.ok(result.includes("Footer"));
	});
});

// ---------------------------------------------------------------------------
// readClaudeCodeMemories
// ---------------------------------------------------------------------------

describe("readClaudeCodeMemories", () => {
	// Use a unique fake cwd so the encoded path never conflicts with real data
	let fakeCwd: string;
	let memoryDir: string;

	function encodeCwd(cwd: string): string {
		return cwd.replace(/\//g, "-");
	}

	beforeEach(() => {
		// Create a unique fake cwd path (not a real directory — just a string for encoding)
		const rand = Math.random().toString(36).slice(2, 10);
		fakeCwd = `/tmp/test-bobbit-memories-${rand}`;
		const encoded = encodeCwd(fakeCwd);
		memoryDir = path.join(os.homedir(), ".claude", "projects", encoded, "memory");
		fs.mkdirSync(memoryDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up the entire project dir we created under ~/.claude/projects/
		const encoded = encodeCwd(fakeCwd);
		const projectDir = path.join(os.homedir(), ".claude", "projects", encoded);
		try {
			fs.rmSync(projectDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	function writeMemoryFile(filename: string, name: string, type: string, body: string, description = "desc") {
		const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n${body}`;
		fs.writeFileSync(path.join(memoryDir, filename), content, "utf-8");
	}

	it("reads valid memory files", () => {
		writeMemoryFile("mem1.md", "First Memory", "user", "First body");
		writeMemoryFile("mem2.md", "Second Memory", "project", "Second body");
		const result = readClaudeCodeMemories(fakeCwd);
		assert.ok(result.includes("# Claude Code Project Memories"));
		assert.ok(result.includes("First Memory"));
		assert.ok(result.includes("First body"));
		assert.ok(result.includes("Second Memory"));
		assert.ok(result.includes("Second body"));
	});

	it("skips MEMORY.md", () => {
		fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Index\nThis is the index.", "utf-8");
		writeMemoryFile("real.md", "Real Memory", "user", "Real body");
		const result = readClaudeCodeMemories(fakeCwd);
		assert.ok(result.includes("Real Memory"));
		assert.ok(!result.includes("Index"));
	});

	it("filters by type — skips reference type", () => {
		writeMemoryFile("allowed-user.md", "User Mem", "user", "User body");
		writeMemoryFile("allowed-project.md", "Project Mem", "project", "Project body");
		writeMemoryFile("allowed-feedback.md", "Feedback Mem", "feedback", "Feedback body");
		writeMemoryFile("blocked-reference.md", "Ref Mem", "reference", "Reference body");
		const result = readClaudeCodeMemories(fakeCwd);
		assert.ok(result.includes("User Mem"));
		assert.ok(result.includes("Project Mem"));
		assert.ok(result.includes("Feedback Mem"));
		assert.ok(!result.includes("Ref Mem"));
		assert.ok(!result.includes("Reference body"));
	});

	it("returns empty string when memory directory does not exist", () => {
		const noMemCwd = `/tmp/test-bobbit-no-memories-${Math.random().toString(36).slice(2, 10)}`;
		const result = readClaudeCodeMemories(noMemCwd);
		assert.strictEqual(result, "");
	});

	it("caps at 20 files", () => {
		// Create 25 memory files
		for (let i = 0; i < 25; i++) {
			const num = String(i).padStart(2, "0");
			writeMemoryFile(`mem-${num}.md`, `Memory ${num}`, "user", `Body ${num}`);
		}
		const result = readClaudeCodeMemories(fakeCwd);
		// First 20 alphabetically should be included (mem-00 through mem-19)
		assert.ok(result.includes("Memory 19"));
		// mem-20 through mem-24 should be excluded
		assert.ok(!result.includes("Memory 20"));
		assert.ok(!result.includes("Memory 24"));
	});

	it("caps total content at 16000 characters", () => {
		// Create files with large bodies — each ~4000 chars, so 5 would exceed 16000
		const bigBody = "X".repeat(4000);
		for (let i = 0; i < 6; i++) {
			writeMemoryFile(`big-${i}.md`, `Big ${i}`, "user", bigBody);
		}
		const result = readClaudeCodeMemories(fakeCwd);
		// Should have some content but be capped
		assert.ok(result.length > 0);
		assert.ok(result.length <= 16500); // Allow small overhead for headers/formatting
		// Not all 6 files should be included
		const memoryCount = (result.match(/### Big \d/g) || []).length;
		assert.ok(memoryCount < 6, `Expected fewer than 6 memories but got ${memoryCount}`);
		assert.ok(memoryCount >= 3, `Expected at least 3 memories but got ${memoryCount}`);
	});
});
