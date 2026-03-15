import type { Workflow } from "./types.js";

const workflows = new Map<string, Workflow>();

export function registerWorkflow(workflow: Workflow): void {
	workflows.set(workflow.id, workflow);
}

export function getWorkflow(id: string): Workflow | undefined {
	return workflows.get(id);
}

export function listWorkflows(): Workflow[] {
	return Array.from(workflows.values());
}
