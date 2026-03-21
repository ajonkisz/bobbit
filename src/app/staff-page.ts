import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Clock, Eye, Pencil, Play, Pause, Plus, Trash2, UserCheck, Zap } from "lucide";
import { fetchStaff, fetchStaffAgent, updateStaffAgent, deleteStaffAgent, wakeStaffAgent, type StaffAgent } from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { connectToSession } from "./session-manager.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let staffList: StaffAgent[] = [];
let selectedStaff: StaffAgent | null = null;
let loading = true;
let saving = false;
let deleting = false;

// Edit form state
let editName = "";
let editDescription = "";
let editPrompt = "";
let editCwd = "";
let editTriggers = "[]";
let editMemory = "";

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadStaffPageData(): Promise<void> {
	currentView = "list";
	selectedStaff = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	staffList = await fetchStaff();
	loading = false;
	renderApp();
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedStaff = null;
	setHashRoute("staff");
}

function showEdit(agent: StaffAgent): void {
	currentView = "edit";
	selectedStaff = agent;
	editName = agent.name;
	editDescription = agent.description;
	editPrompt = agent.systemPrompt;
	editCwd = agent.cwd;
	editTriggers = JSON.stringify(agent.triggers, null, 2);
	editMemory = agent.memory || "";
	saving = false;
	deleting = false;
	setHashRoute("staff-edit", agent.id);
}

export function navigateToStaffEdit(staffId: string): void {
	const agent = staffList.find((s) => s.id === staffId);
	if (agent) {
		currentView = "edit";
		selectedStaff = agent;
		editName = agent.name;
		editDescription = agent.description;
		editPrompt = agent.systemPrompt;
		editCwd = agent.cwd;
		editTriggers = JSON.stringify(agent.triggers, null, 2);
		editMemory = agent.memory || "";
		saving = false;
		deleting = false;
	}
	renderApp();
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	if (!selectedStaff || saving) return;
	saving = true;
	renderApp();
	let triggers: any[] = [];
	try {
		triggers = JSON.parse(editTriggers);
	} catch {
		triggers = selectedStaff.triggers;
	}
	const ok = await updateStaffAgent(selectedStaff.id, {
		name: editName,
		description: editDescription,
		systemPrompt: editPrompt,
		cwd: editCwd,
		triggers,
		memory: editMemory,
	});
	if (ok) {
		staffList = await fetchStaff();
		const updated = staffList.find((s) => s.id === selectedStaff!.id);
		if (updated) selectedStaff = updated;
	}
	saving = false;
	renderApp();
}

async function handleDelete(): Promise<void> {
	if (!selectedStaff || deleting) return;
	if (!confirm(`Delete staff agent "${selectedStaff.name}"?`)) return;
	deleting = true;
	renderApp();
	const ok = await deleteStaffAgent(selectedStaff.id);
	if (ok) {
		staffList = await fetchStaff();
		showList();
	}
	deleting = false;
	renderApp();
}

async function handleTogglePause(): Promise<void> {
	if (!selectedStaff) return;
	const newState = selectedStaff.state === "paused" ? "active" : "paused";
	const ok = await updateStaffAgent(selectedStaff.id, { state: newState });
	if (ok) {
		staffList = await fetchStaff();
		const updated = staffList.find((s) => s.id === selectedStaff!.id);
		if (updated) selectedStaff = updated;
	}
	renderApp();
}

async function handleWake(): Promise<void> {
	if (!selectedStaff) return;
	const result = await wakeStaffAgent(selectedStaff.id, "Manual wake");
	if (result?.sessionId) {
		await connectToSession(result.sessionId, false);
	}
}

// ============================================================================
// HELPERS
// ============================================================================

function relativeTime(ts?: number): string {
	if (!ts) return "Never";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "Just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function stateBadge(s: string): TemplateResult {
	const colors: Record<string, string> = {
		active: "bg-green-500/15 text-green-700 dark:text-green-400",
		paused: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
		retired: "bg-muted text-muted-foreground",
	};
	return html`<span class="px-2 py-0.5 text-xs rounded-full ${colors[s] || colors.retired}">${s}</span>`;
}

function triggerSummary(triggers: any[]): string {
	if (!triggers || triggers.length === 0) return "Manual only";
	return triggers.map((t: any) => {
		if (t.type === "schedule") return `Cron: ${t.config?.cron || "?"}`;
		if (t.type === "git") return `Git: ${t.config?.event || "push"}`;
		return t.type;
	}).join(", ");
}

// ============================================================================
// LIST VIEW
// ============================================================================

function renderListView(): TemplateResult {
	if (loading) {
		return html`<div class="text-center py-12 text-muted-foreground text-sm">Loading...</div>`;
	}

	return html`
		<div class="flex-1 flex flex-col overflow-hidden">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<div class="flex items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => setHashRoute("landing"),
						children: html`${icon(ArrowLeft, "sm")}`,
					})}
					<h1 class="text-lg font-semibold">Staff Agents</h1>
				</div>
			</div>
			<div class="flex-1 overflow-y-auto">
				${staffList.length === 0
					? html`
						<div class="text-center py-12">
							<div class="text-muted-foreground mb-3">${icon(UserCheck, "lg")}</div>
							<p class="text-sm text-muted-foreground mb-4">No staff agents yet</p>
							<p class="text-xs text-muted-foreground max-w-sm mx-auto">
								Create a staff agent from the sidebar using the + button next to "Staff",
								or use the Staff Assistant.
							</p>
						</div>
					`
					: html`
						<table class="w-full text-sm">
							<thead>
								<tr class="border-b border-border text-xs text-muted-foreground uppercase tracking-wider">
									<th class="text-left px-4 py-2 font-medium">Name</th>
									<th class="text-left px-4 py-2 font-medium">State</th>
									<th class="text-left px-4 py-2 font-medium">Triggers</th>
									<th class="text-left px-4 py-2 font-medium">Last Active</th>
								</tr>
							</thead>
							<tbody>
								${staffList.map((agent) => html`
									<tr class="border-b border-border/50 hover:bg-secondary/30 cursor-pointer transition-colors"
										@click=${() => showEdit(agent)}>
										<td class="px-4 py-3">
											<div class="font-medium">${agent.name}</div>
											<div class="text-xs text-muted-foreground truncate max-w-[300px]">${agent.description}</div>
										</td>
										<td class="px-4 py-3">${stateBadge(agent.state)}</td>
										<td class="px-4 py-3 text-muted-foreground text-xs">${triggerSummary(agent.triggers)}</td>
										<td class="px-4 py-3 text-muted-foreground text-xs">${relativeTime(agent.lastWakeAt)}</td>
									</tr>
								`)}
							</tbody>
						</table>
					`
				}
			</div>
		</div>
	`;
}

// ============================================================================
// EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	if (!selectedStaff) return html`<div class="p-4">Staff agent not found</div>`;

	return html`
		<div class="flex-1 flex flex-col overflow-hidden">
			<div class="flex items-center justify-between p-4 border-b border-border shrink-0">
				<div class="flex items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: showList,
						children: html`${icon(ArrowLeft, "sm")}`,
					})}
					<h1 class="text-lg font-semibold">${selectedStaff.name}</h1>
					${stateBadge(selectedStaff.state)}
				</div>
				<div class="flex items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: handleTogglePause,
						children: html`<span class="inline-flex items-center gap-1">${icon(selectedStaff.state === "paused" ? Play : Pause, "sm")} ${selectedStaff.state === "paused" ? "Resume" : "Pause"}</span>`,
					})}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleWake,
						children: html`<span class="inline-flex items-center gap-1">${icon(Zap, "sm")} Wake Now</span>`,
					})}
					${selectedStaff.currentSessionId ? Button({
						variant: "outline",
						size: "sm",
						onClick: () => connectToSession(selectedStaff!.currentSessionId!, true),
						children: html`<span class="inline-flex items-center gap-1">${icon(Eye, "sm")} View Session</span>`,
					}) : ""}
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: handleDelete,
						disabled: deleting,
						children: html`<span class="inline-flex items-center gap-1 text-destructive">${icon(Trash2, "sm")} Delete</span>`,
					})}
				</div>
			</div>
			<div class="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
				<!-- Basic fields -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
						${Input({
							type: "text",
							value: editName,
							onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); },
						})}
					</div>
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
						${Input({
							type: "text",
							value: editCwd,
							onInput: (e: Event) => { editCwd = (e.target as HTMLInputElement).value; renderApp(); },
						})}
					</div>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					<textarea
						class="w-full p-2 text-sm rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="2"
						.value=${editDescription}
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>

				<!-- System Prompt -->
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">System Prompt</label>
					<textarea
						class="w-full p-2 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="8"
						.value=${editPrompt}
						@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>

				<!-- Triggers -->
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Triggers (JSON)</label>
					<textarea
						class="w-full p-2 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="6"
						.value=${editTriggers}
						@input=${(e: Event) => { editTriggers = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>

				<!-- Pinned Context -->
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Pinned Context (optional)</label>
					<p class="text-[10px] text-muted-foreground mb-1">Injected into the system prompt. Survives conversation compaction.</p>
					<textarea
						class="w-full p-2 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="4"
						.value=${editMemory}
						@input=${(e: Event) => { editMemory = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>

				<!-- Save -->
				<div class="flex items-center justify-end gap-2 pt-2 border-t border-border">
					${Button({
						variant: "ghost",
						onClick: showList,
						children: "Cancel",
					})}
					${Button({
						variant: "default",
						onClick: handleSave,
						disabled: saving,
						children: saving ? "Saving..." : "Save Changes",
					})}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER
// ============================================================================

export function renderStaffPage(): TemplateResult {
	if (currentView === "edit") return renderEditView();
	return renderListView();
}
