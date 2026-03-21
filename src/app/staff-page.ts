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
let editPromptEditMode = false;
let editCwd = "";
let editTriggers: TriggerDef[] = [];
let editMemory = "";

interface TriggerDef {
	type: string;
	config: Record<string, any>;
	enabled: boolean;
	prompt?: string;
}

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
	editPromptEditMode = false;
	editCwd = agent.cwd;
	editTriggers = parseTriggers(JSON.stringify(agent.triggers));
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
		editPromptEditMode = false;
		editCwd = agent.cwd;
		editTriggers = parseTriggers(JSON.stringify(agent.triggers));
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
	const ok = await updateStaffAgent(selectedStaff.id, {
		name: editName,
		description: editDescription,
		systemPrompt: editPrompt,
		cwd: editCwd,
		triggers: editTriggers,
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
// TRIGGER EDITOR
// ============================================================================

function parseTriggers(json: string): TriggerDef[] {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

function updateTrigger(index: number, updater: (t: TriggerDef) => void) {
	if (editTriggers[index]) {
		updater(editTriggers[index]);
		renderApp();
	}
}

function removeTrigger(index: number) {
	editTriggers.splice(index, 1);
	renderApp();
}

function addTrigger() {
	editTriggers.push({ type: "schedule", config: { cron: "0 9 * * *" }, enabled: true, prompt: "" });
	renderApp();
}

function renderTriggersEditor() {
	if (editTriggers.length === 0) {
		return html`<div class="text-xs text-muted-foreground italic p-3 border border-dashed border-border rounded-md">No triggers configured. Add one above.</div>`;
	}
	return html`<div class="flex flex-col gap-2">${editTriggers.map((t, i) => renderTriggerCard(t, i))}</div>`;
}

function renderTriggerCard(trigger: TriggerDef, index: number) {
	const typeLabel: Record<string, string> = { schedule: "\u23F0 Schedule", git: "\uD83D\uDD00 Git", manual: "\uD83D\uDC46 Manual" };
	const typeOptions = ["schedule", "git", "manual"];
	const inputClass = "w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

	const onTypeChange = (e: Event) => {
		const newType = (e.target as HTMLSelectElement).value;
		updateTrigger(index, (t) => {
			t.type = newType;
			if (newType === "schedule") t.config = { cron: "0 9 * * *" };
			else if (newType === "git") t.config = { event: "push", branch: "master" };
			else t.config = {};
		});
	};

	return html`
		<div class="rounded-md border border-border bg-secondary/20 p-3">
			<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
				<select
					class="text-xs px-2 py-1 rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					.value=${trigger.type}
					@change=${onTypeChange}
				>
					${typeOptions.map((opt) => html`<option value=${opt} ?selected=${trigger.type === opt}>${typeLabel[opt] || opt}</option>`)}
				</select>
				<label style="display:flex; align-items:center; gap:4px; margin-left:auto; font-size:11px" class="text-muted-foreground cursor-pointer select-none">
					<input
						type="checkbox"
						class="accent-primary"
						.checked=${trigger.enabled !== false}
						@change=${(e: Event) => updateTrigger(index, (t) => { t.enabled = (e.target as HTMLInputElement).checked; })}
					/> Enabled
				</label>
				<button
					class="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
					title="Remove trigger"
					@click=${() => removeTrigger(index)}
				>\u2715</button>
			</div>

			${trigger.type === "schedule" ? html`
				<div style="margin-bottom:4px">
					<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Cron expression (UTC)</label>
					<input
						type="text"
						class=${inputClass}
						placeholder="0 9 * * *"
						.value=${trigger.config?.cron || ""}
						@input=${(e: Event) => updateTrigger(index, (t) => { t.config.cron = (e.target as HTMLInputElement).value; })}
					/>
				</div>
				<div class="text-[10px] text-muted-foreground" style="margin-bottom:8px">${describeCron(trigger.config?.cron || "")}</div>
			` : ""}

			${trigger.type === "git" ? html`
				<div style="display:grid; grid-template-columns:100px 1fr; gap:8px; margin-bottom:8px">
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Event</label>
						<select
							class=${inputClass}
							.value=${trigger.config?.event || "push"}
							@change=${(e: Event) => updateTrigger(index, (t) => { t.config.event = (e.target as HTMLSelectElement).value; })}
						>
							<option value="push" ?selected=${trigger.config?.event === "push"}>push</option>
						</select>
					</div>
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Branch</label>
						<input
							type="text"
							class=${inputClass}
							placeholder="master"
							.value=${trigger.config?.branch || ""}
							@input=${(e: Event) => updateTrigger(index, (t) => { t.config.branch = (e.target as HTMLInputElement).value; })}
						/>
					</div>
				</div>
			` : ""}

			<div>
				<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Wake prompt (optional)</label>
				<textarea
					class="w-full p-2 text-xs rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
					rows="2"
					placeholder="Message sent to the agent when this trigger fires"
					.value=${trigger.prompt || ""}
					@input=${(e: Event) => updateTrigger(index, (t) => { t.prompt = (e.target as HTMLTextAreaElement).value; })}
				></textarea>
			</div>
		</div>
	`;
}

function describeCron(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron ? `Custom: ${cron}` : "";
	const [min, hour, dom, mon, dow] = parts;

	const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

	let timeStr = "";
	if (min !== "*" && hour !== "*") {
		const h = parseInt(hour, 10);
		const m = parseInt(min, 10);
		if (!isNaN(h) && !isNaN(m)) {
			const ampm = h >= 12 ? "PM" : "AM";
			const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
			timeStr = `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
		}
	}

	if (hour.startsWith("*/")) {
		const n = hour.slice(2);
		const base = min === "0" ? "on the hour" : `at :${min.padStart(2, "0")}`;
		return `Every ${n} hour${n === "1" ? "" : "s"}, ${base}`;
	}
	if (min.startsWith("*/")) {
		const n = min.slice(2);
		return `Every ${n} minute${n === "1" ? "" : "s"}`;
	}
	if (dom === "*" && mon === "*" && dow === "*" && timeStr) return `Daily at ${timeStr}`;
	if (dom === "*" && mon === "*" && dow === "1-5" && timeStr) return `Weekdays at ${timeStr}`;
	if (dom === "*" && mon === "*" && dow !== "*" && timeStr) {
		const dowNum = parseInt(dow, 10);
		const dayName = !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6 ? dayNames[dowNum] : dow;
		return `Every ${dayName} at ${timeStr}`;
	}
	if (dom !== "*" && mon === "*" && dow === "*" && timeStr) {
		const suffix = dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th";
		return `${dom}${suffix} of each month at ${timeStr}`;
	}
	return cron ? `Custom: ${cron}` : "";
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
	if (!triggers || triggers.length === 0) return "No triggers";
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
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: editName,
						placeholder: "Staff agent name",
						onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); },
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					<textarea
						class="w-full p-2 text-sm rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="2"
						placeholder="What does this staff agent do?"
						.value=${editDescription}
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
					${Input({
						type: "text",
						value: editCwd,
						placeholder: "(server default)",
						onInput: (e: Event) => { editCwd = (e.target as HTMLInputElement).value; renderApp(); },
					})}
				</div>
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Triggers</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							@click=${addTrigger}
						>+ Add trigger</button>
					</div>
					${renderTriggersEditor()}
				</div>
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							@click=${() => { editPromptEditMode = !editPromptEditMode; renderApp(); }}
						>
							${editPromptEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${editPromptEditMode
						? html`<textarea
								class="p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								style="min-height:150px; max-height:400px; width:100%"
								.value=${editPrompt}
								@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
							></textarea>`
						: html`<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm" style="min-height:150px; max-height:400px">
								<markdown-block .content=${editPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Pinned Context (optional)</label>
					<p class="text-[10px] text-muted-foreground mb-1">Injected into the system prompt. Survives conversation compaction.</p>
					<textarea
						class="w-full p-2 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="4"
						.value=${editMemory}
						@input=${(e: Event) => { editMemory = (e.target as HTMLTextAreaElement).value; }}
					></textarea>
				</div>

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
