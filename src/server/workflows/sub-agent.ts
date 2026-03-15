/**
 * Sub-agent orchestration for workflows.
 *
 * Spawns independent agent sessions with isolated context for workflow phases.
 * The sub-agent receives ONLY:
 *   - Phase instructions (from workflow definition)
 *   - Artifacts/context passed explicitly
 *   - AGENTS.md from the working directory (for project knowledge)
 *
 * It does NOT receive the parent session's conversation history.
 * This ensures unbiased, independent execution.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { RpcBridge, type RpcBridgeOptions } from "../agent/rpc-bridge.js";
import { assembleSystemPrompt } from "../agent/system-prompt.js";
import type { Phase, WorkflowArtifact } from "./types.js";
import { storeArtifact } from "./artifact-store.js";

const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes default

export interface SubAgentRequest {
	/** Unique id for tracking */
	id: string;
	/** The workflow phase to execute */
	phase: Phase;
	/** Working directory (same as parent session) */
	cwd: string;
	/** The prompt sent to the sub-agent (phase instructions + context) */
	prompt: string;
	/** Parent session ID (for artifact namespacing) */
	parentSessionId: string;
	/** Path to the agent CLI (optional, auto-resolved if omitted) */
	agentCliPath?: string;
	/** Timeout in ms (default: 10 minutes) */
	timeoutMs?: number;
}

export interface SubAgentResult {
	id: string;
	phaseId: string;
	status: "completed" | "failed" | "timeout";
	/** Full conversation from the sub-agent (for debugging / report) */
	conversation: string;
	/** Artifacts collected (if the sub-agent used the workflow tool) */
	artifacts: WorkflowArtifact[];
	/** Duration in ms */
	durationMs: number;
	/** Error message if failed */
	error?: string;
}

/**
 * Build a system prompt for a sub-agent.
 * Contains only phase instructions + explicit context — no parent conversation.
 */
function buildSubAgentPrompt(phase: Phase, context: Record<string, string>): string {
	const sections: string[] = [];

	sections.push(`# Workflow Phase: ${phase.name}`);
	sections.push("");
	sections.push(phase.instructions);
	sections.push("");
	sections.push(`**Exit criteria:** ${phase.exitCriteria}`);

	if (Object.keys(context).length > 0) {
		sections.push("");
		sections.push("## Context");
		for (const [key, value] of Object.entries(context)) {
			sections.push(`- **${key}**: ${value}`);
		}
	}

	sections.push("");
	sections.push("## Important");
	sections.push("- Complete this phase and then stop. Do not proceed to other phases.");
	sections.push("- Use the workflow tool to collect artifacts and set context values.");
	sections.push("- When done, use the workflow tool with action 'complete' to signal completion.");

	return sections.join("\n");
}

/**
 * Run a single phase in an independent sub-agent.
 *
 * Spawns a new agent process, sends the phase prompt, waits for completion
 * (agent_end event), and collects the conversation output.
 */
export async function runSubAgent(request: SubAgentRequest): Promise<SubAgentResult> {
	const startTime = Date.now();
	const subSessionId = `sub-${request.parentSessionId.slice(0, 8)}-${request.phase.id}-${randomUUID().slice(0, 8)}`;
	const timeoutMs = request.timeoutMs ?? SUB_AGENT_TIMEOUT_MS;

	// Assemble a minimal system prompt: AGENTS.md for project context + phase instructions
	const systemPromptPath = assembleSystemPrompt(subSessionId, {
		cwd: request.cwd,
		goalSpec: request.prompt,
		goalTitle: `Workflow Phase: ${request.phase.name}`,
		goalState: "active",
	});

	const bridgeOptions: RpcBridgeOptions = {
		cwd: request.cwd,
	};
	if (request.agentCliPath) bridgeOptions.cliPath = request.agentCliPath;
	if (systemPromptPath) bridgeOptions.systemPromptPath = systemPromptPath;

	const rpc = new RpcBridge(bridgeOptions);
	const events: any[] = [];
	let conversationText = "";

	const unsub = rpc.onEvent((event: any) => {
		events.push(event);
	});

	try {
		await rpc.start();

		// Send the phase prompt and wait for the agent to finish
		const completionPromise = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const eventUnsub = rpc.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					eventUnsub();
					resolve();
				}
			});
		});

		// Send the prompt — the phase instructions are in the system prompt,
		// so we send a brief kickoff message
		await rpc.prompt(
			`Execute the workflow phase "${request.phase.name}". Follow the instructions in your system prompt carefully.`,
		);

		await completionPromise;

		// Collect conversation for the report
		try {
			const msgsResp = await rpc.getMessages();
			if (msgsResp.success && Array.isArray(msgsResp.data)) {
				conversationText = extractConversationText(msgsResp.data);
			}
		} catch {
			// Non-fatal — we still have the events
		}

		// Check if sub-agent collected artifacts via the workflow tool
		const artifacts = collectSubAgentArtifacts(events, request.parentSessionId, request.phase.id);

		return {
			id: request.id,
			phaseId: request.phase.id,
			status: "completed",
			conversation: conversationText,
			artifacts,
			durationMs: Date.now() - startTime,
		};
	} catch (err: any) {
		const isTimeout = err.message?.includes("timed out");
		return {
			id: request.id,
			phaseId: request.phase.id,
			status: isTimeout ? "timeout" : "failed",
			conversation: conversationText,
			artifacts: [],
			durationMs: Date.now() - startTime,
			error: err.message,
		};
	} finally {
		unsub();
		await rpc.stop().catch(() => {});
		// Clean up the temporary system prompt file
		try {
			const promptDir = path.join(os.homedir(), ".pi", "session-prompts");
			const promptFile = path.join(promptDir, `${subSessionId}.md`);
			if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
		} catch { /* ignore */ }
	}
}

/**
 * Run multiple phases in parallel as independent sub-agents.
 * Returns results in the same order as the input requests.
 */
export async function runSubAgentsParallel(requests: SubAgentRequest[]): Promise<SubAgentResult[]> {
	return Promise.all(requests.map((req) => runSubAgent(req)));
}

/**
 * Build a sub-agent request for a workflow phase.
 */
export function createSubAgentRequest(
	phase: Phase,
	context: Record<string, string>,
	parentSessionId: string,
	cwd: string,
	agentCliPath?: string,
	timeoutMs?: number,
): SubAgentRequest {
	const prompt = buildSubAgentPrompt(phase, context);
	return {
		id: randomUUID(),
		phase,
		cwd,
		prompt,
		parentSessionId,
		agentCliPath,
		timeoutMs,
	};
}

// --- Helpers ---

/**
 * Extract readable conversation text from agent messages.
 */
function extractConversationText(messages: any[]): string {
	const lines: string[] = [];
	for (const msg of messages) {
		if (!msg || !msg.role) continue;
		if (msg.role === "user") {
			const text = typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			if (text) lines.push(`USER: ${text}`);
		} else if (msg.role === "assistant") {
			const text = Array.isArray(msg.content)
				? msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
				: typeof msg.content === "string" ? msg.content : "";
			if (text) lines.push(`ASSISTANT: ${text}`);
		}
	}
	return lines.join("\n\n");
}

/**
 * Scan agent events for workflow tool artifact collections.
 * When a sub-agent uses `workflow collect_artifact`, we capture the results
 * and re-store them under the parent session's artifact directory.
 */
function collectSubAgentArtifacts(
	events: any[],
	parentSessionId: string,
	phaseId: string,
): WorkflowArtifact[] {
	const artifacts: WorkflowArtifact[] = [];

	for (const event of events) {
		// Look for tool_execution_end events from the workflow tool
		if (event.type !== "tool_execution_end" || event.toolName !== "workflow") continue;

		const result = event.result;
		if (!result?.content) continue;

		// Parse the text result to detect artifact collection confirmations
		const text = Array.isArray(result.content)
			? result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
			: "";

		const match = text.match(/Artifact "([^"]+)" collected/);
		if (match) {
			// The sub-agent's workflow extension stored the artifact under its own session ID.
			// We note the name; the parent workflow can retrieve it later.
			artifacts.push({
				name: match[1],
				filePath: "", // Will be resolved by parent
				mimeType: "text/plain",
				collectedAt: Date.now(),
				phaseId,
			});
		}
	}

	return artifacts;
}
