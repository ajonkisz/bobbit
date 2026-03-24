#!/usr/bin/env node
/**
 * Mock pi-coding-agent for E2E tests.
 * Speaks the same JSONL stdin/stdout RPC protocol as the real agent.
 * Responds to prompts with deterministic tool calls — no API needed, instant.
 *
 * Usage: node mock-agent.mjs --mode rpc [--cwd ...] [--tools ...]
 */
import { createInterface } from "node:readline";
import fs from "node:fs";

const rl = createInterface({ input: process.stdin });

/** Send a JSONL message to stdout */
function send(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

/** Emit an agent event (no request id) */
function emit(event) {
	send(event);
}

/** Extract a file path from prompt text (handles Windows and Unix paths) */
function extractFilePath(text) {
	// Match Windows paths like C:\Users\...\foo.txt or Unix paths like /tmp/foo.txt
	const winMatch = text.match(/[A-Z]:[\\\/][^\s"']+/);
	if (winMatch) return winMatch[0].replace(/[.,;:!?)]+$/, '');
	const unixMatch = text.match(/\/[\w./-]+/);
	if (unixMatch) return unixMatch[0].replace(/[.,;:!?)]+$/, '');
	return "/tmp/mock-file.txt";
}

/** Detect which tool the prompt is asking for and return a canned response */
function respondToPrompt(text) {
	const lower = text.toLowerCase();

	// Detect tool requests by keywords
	if (lower.includes("bash") || lower.includes("echo ")) {
		return { tool: "Bash", input: { command: "echo BOBBIT_TOOL_TEST_OK_12345" }, output: "BOBBIT_TOOL_TEST_OK_12345\n" };
	}
	if (lower.includes("write tool") || lower.includes("use the write")) {
		const filePath = extractFilePath(text);
		return { tool: "Write", input: { path: filePath, content: "E2E_WRITE_TEST\n" }, output: `Wrote to ${filePath}` };
	}
	if (lower.includes("read tool") || lower.includes("use the read")) {
		const filePath = extractFilePath(text);
		return { tool: "Read", input: { path: filePath }, output: "READ_THIS_CONTENT_E2E\n" };
	}
	if (lower.includes("edit tool") || lower.includes("use the edit")) {
		const filePath = extractFilePath(text);
		return { tool: "Edit", input: { path: filePath, oldText: "ORIGINAL_VALUE", newText: "EDITED_VALUE" }, output: "Edited successfully" };
	}
	// Default: just reply with text
	return null;
}

/** Simulate a full agent turn: streaming start → tool calls → assistant text → end */
async function handlePrompt(requestId, text) {
	// Acknowledge the prompt
	send({ type: "response", id: requestId, success: true });

	// Emit agent lifecycle events
	emit({ type: "agent_start" });
	emit({ type: "session_status", status: "streaming" });

	const toolAction = respondToPrompt(text);

	if (toolAction) {
		const toolId = `tool_${Date.now()}`;

		// Tool execution start
		emit({
			type: "tool_execution_start",
			toolName: toolAction.tool,
			toolId,
			input: toolAction.input,
		});

		// Actually execute Write and Edit tools for real file system effects
		if (toolAction.tool === "Write" && toolAction.input.path && toolAction.input.content) {
			try { fs.writeFileSync(toolAction.input.path, toolAction.input.content, "utf-8"); } catch { /* best effort */ }
		}
		if (toolAction.tool === "Edit" && toolAction.input.path) {
			try {
				const content = fs.readFileSync(toolAction.input.path, "utf-8");
				fs.writeFileSync(toolAction.input.path, content.replace(toolAction.input.oldText, toolAction.input.newText), "utf-8");
			} catch { /* best effort */ }
		}

		// Tool execution end
		emit({
			type: "tool_execution_update",
			toolId,
			toolName: toolAction.tool,
			status: "complete",
			output: toolAction.output,
		});

		// Assistant message with tool result
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", id: toolId, name: toolAction.tool, input: toolAction.input },
					{ type: "text", text: `Done. Used ${toolAction.tool} tool.` },
				],
			},
		});
	} else {
		// Simple text response
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "OK" }],
			},
		});
	}

	// Agent turn complete
	emit({ type: "agent_end" });
	emit({ type: "session_status", status: "idle" });
}

// Handle RPC commands from stdin
rl.on("line", async (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;

	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}

	switch (msg.type) {
		case "prompt":
		case "follow_up":
			await handlePrompt(msg.id, msg.message || "");
			break;

		case "steer":
			send({ type: "response", id: msg.id, success: true });
			break;

		case "abort":
			send({ type: "response", id: msg.id, success: true });
			emit({ type: "agent_end" });
			emit({ type: "session_status", status: "idle" });
			break;

		case "get_state":
			send({ type: "response", id: msg.id, success: true, data: { status: "idle" } });
			break;

		case "get_messages":
			send({ type: "response", id: msg.id, success: true, data: [] });
			break;

		case "set_model":
			send({ type: "response", id: msg.id, success: true });
			break;

		case "compact":
			send({ type: "response", id: msg.id, success: true });
			break;

		default:
			send({ type: "response", id: msg.id, success: true });
	}
});

// Signal readiness
emit({ type: "session_status", status: "idle" });
