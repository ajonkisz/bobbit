/**
 * Workflow definitions sync.
 *
 * The server is the canonical source of workflow definitions.
 * On startup it writes them to a well-known JSON file so the
 * agent-side extension can discover them without duplication.
 *
 * Path: ~/.pi/workflow-definitions.json
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listWorkflows } from "./registry.js";

export const DEFINITIONS_PATH = path.join(os.homedir(), ".pi", "workflow-definitions.json");

/**
 * Write all registered workflow definitions to disk.
 * Call this after all workflows have been registered (server startup).
 */
export function exportDefinitions(): void {
	const workflows = listWorkflows();
	const data = {
		version: 1,
		exportedAt: Date.now(),
		workflows,
	};
	fs.mkdirSync(path.dirname(DEFINITIONS_PATH), { recursive: true });
	fs.writeFileSync(DEFINITIONS_PATH, JSON.stringify(data, null, 2), "utf-8");
	console.log(`[workflows] Exported ${workflows.length} workflow definitions to ${DEFINITIONS_PATH}`);
}
