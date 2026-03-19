/**
 * Sub-agent orchestration for skills.
 *
 * Spawns independent agent sessions with isolated context for skill execution.
 * The sub-agent receives ONLY:
 *   - Skill instructions (from skill definition)
 *   - Context passed explicitly (e.g. branch names, repo path)
 *   - AGENTS.md from the working directory (for project knowledge)
 *
 * It does NOT receive the parent session's conversation history (for full isolation).
 *
 * Simplified from workflows/sub-agent.ts — no phase tracking, no workflow tool.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RpcBridge, type RpcBridgeOptions } from "../agent/rpc-bridge.js";
import { assembleSystemPrompt } from "../agent/system-prompt.js";
import type { Skill } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface SkillInvocationRequest {
	/** Unique id for tracking */
	id: string;
	/** The skill to execute */
	skill: Skill;
	/** Working directory (same as parent session) */
	cwd: string;
	/** Extra context key-values passed to the sub-agent */
	context?: Record<string, string>;
	/** Parent session ID (for namespacing) */
	parentSessionId: string;
	/** Path to the agent CLI (optional, auto-resolved if omitted) */
	agentCliPath?: string;
}

export interface SkillInvocationResult {
	id: string;
	skillId: string;
	status: "completed" | "failed" | "timeout";
	/** The sub-agent's final output */
	output: string;
	/** Duration in ms */
	durationMs: number;
	/** Error message if failed */
	error?: string;
}

/**
 * Build a system prompt for a skill sub-agent.
 * Contains skill instructions + explicit context — no parent conversation.
 */
function buildSkillPrompt(skill: Skill, context?: Record<string, string>): string {
	const sections: string[] = [];

	sections.push(`# Skill: ${skill.name}`);
	sections.push("");
	sections.push(skill.instructions);

	if (context && Object.keys(context).length > 0) {
		sections.push("");
		sections.push("## Context");
		for (const [key, value] of Object.entries(context)) {
			sections.push(`- **${key}**: ${value}`);
		}
	}

	sections.push("");
	sections.push("## Expected Output");
	sections.push(skill.expectedOutput);
	sections.push("");
	sections.push("## Important");
	sections.push("- Complete this skill and then stop.");
	sections.push("- Produce the expected output format described above.");

	return sections.join("\n");
}

/**
 * Run a skill in an independent sub-agent process.
 *
 * Spawns a new agent, sends a kickoff prompt, waits for completion,
 * and collects the conversation output.
 */
export async function runSkillAgent(request: SkillInvocationRequest): Promise<SkillInvocationResult> {
	const startTime = Date.now();
	const subSessionId = `skill-${request.parentSessionId.slice(0, 8)}-${request.skill.id}-${randomUUID().slice(0, 8)}`;
	const timeoutMs = request.skill.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const skillPrompt = buildSkillPrompt(request.skill, request.context);

	// Assemble system prompt: AGENTS.md for project context + skill instructions
	const systemPromptPath = assembleSystemPrompt(subSessionId, {
		cwd: request.cwd,
		goalSpec: skillPrompt,
		goalTitle: `Skill: ${request.skill.name}`,
		goalState: "active",
	});

	const bridgeOptions: RpcBridgeOptions = {
		cwd: request.cwd,
	};
	if (request.agentCliPath) bridgeOptions.cliPath = request.agentCliPath;
	if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

	const rpc = new RpcBridge(bridgeOptions);
	let output = "";

	try {
		await rpc.start();

		// Wait for the agent to finish
		const completionPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Skill agent timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const eventUnsub = rpc.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					eventUnsub();
					resolve();
				}
			});
		});

		// Send kickoff prompt
		await rpc.prompt(
			`Execute the skill "${request.skill.name}". Follow the instructions in your system prompt carefully.`,
		);

		await completionPromise;

		// Collect conversation output
		try {
			const msgsResp = await rpc.getMessages();
			if (msgsResp.success && Array.isArray(msgsResp.data)) {
				output = extractLastAssistantOutput(msgsResp.data);
			}
		} catch {
			// Non-fatal
		}

		return {
			id: request.id,
			skillId: request.skill.id,
			status: "completed",
			output,
			durationMs: Date.now() - startTime,
		};
	} catch (err: any) {
		const isTimeout = err.message?.includes("timed out");
		return {
			id: request.id,
			skillId: request.skill.id,
			status: isTimeout ? "timeout" : "failed",
			output,
			durationMs: Date.now() - startTime,
			error: err.message,
		};
	} finally {
		await rpc.stop().catch(() => {});
		// Clean up temporary system prompt
		try {
			const promptDir = path.join(os.homedir(), ".pi", "session-prompts");
			const promptFile = path.join(promptDir, `${subSessionId}.md`);
			if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
		} catch { /* ignore */ }
	}
}

/**
 * Run multiple skills in parallel as independent sub-agents.
 */
export async function runSkillAgentsParallel(requests: SkillInvocationRequest[]): Promise<SkillInvocationResult[]> {
	return Promise.all(requests.map((req) => runSkillAgent(req)));
}

/**
 * Build a skill invocation request.
 */
export function createSkillRequest(
	skill: Skill,
	parentSessionId: string,
	cwd: string,
	context?: Record<string, string>,
	agentCliPath?: string,
): SkillInvocationRequest {
	return {
		id: randomUUID(),
		skill,
		cwd,
		context,
		parentSessionId,
		agentCliPath,
	};
}

// --- Helpers ---

/**
 * Extract the last assistant message text from agent messages.
 * This is the skill's final output.
 */
function extractLastAssistantOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;

		const text = Array.isArray(msg.content)
			? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
			: typeof msg.content === "string" ? msg.content : "";

		if (text) return text;
	}
	return "";
}
