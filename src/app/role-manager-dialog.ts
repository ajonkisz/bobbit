import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render, nothing } from "lit";
import { ArrowLeft, ChevronRight, Plus, Trash2 } from "lucide";
import { fetchRoles, fetchTools, createRole, updateRole, deleteRole, type RoleData } from "./api.js";
import { ACCESSORIES, ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { renderApp } from "./state.js";

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit" | "create";

let currentView: View = "list";
let roles: RoleData[] = [];
let availableTools: string[] = [];
let selectedRole: RoleData | null = null;
let loading = true;

// Edit form state
let editLabel = "";
let editPrompt = "";
let editTools: string[] = [];
let editAccessory = "none";
let editName = "";
let saving = false;
let deleting = false;

let dialogContainer: HTMLDivElement | null = null;

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadData(): Promise<void> {
	loading = true;
	rerender();
	const [r, t] = await Promise.all([fetchRoles(), fetchTools()]);
	roles = r;
	availableTools = t;
	loading = false;
	rerender();
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedRole = null;
	rerender();
}

function showEdit(role: RoleData): void {
	currentView = "edit";
	selectedRole = role;
	editLabel = role.label;
	editPrompt = role.promptTemplate;
	editTools = [...role.allowedTools];
	editAccessory = role.accessory;
	editName = role.name;
	saving = false;
	deleting = false;
	rerender();
}

function showCreate(): void {
	currentView = "create";
	selectedRole = null;
	editLabel = "";
	editPrompt = "";
	editTools = [];
	editAccessory = "none";
	editName = "";
	saving = false;
	deleting = false;
	rerender();
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	rerender();

	if (currentView === "create") {
		const result = await createRole({
			name: editName,
			label: editLabel,
			promptTemplate: editPrompt,
			allowedTools: editTools,
			accessory: editAccessory,
		});
		if (result) {
			await loadData();
			showList();
			return;
		}
	} else if (selectedRole) {
		const ok = await updateRole(selectedRole.name, {
			label: editLabel,
			promptTemplate: editPrompt,
			allowedTools: editTools,
			accessory: editAccessory,
		});
		if (ok) {
			await loadData();
			// Stay on edit view but refresh the selected role
			const updated = roles.find((r) => r.name === selectedRole!.name);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	rerender();
}

async function handleDelete(): Promise<void> {
	if (!selectedRole) return;
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${selectedRole.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	deleting = true;
	rerender();
	const ok = await deleteRole(selectedRole.name);
	if (ok) {
		await loadData();
		showList();
	} else {
		deleting = false;
		rerender();
	}
}

function toggleTool(tool: string): void {
	const idx = editTools.indexOf(tool);
	if (idx >= 0) {
		editTools = editTools.filter((t) => t !== tool);
	} else {
		editTools = [...editTools, tool];
	}
	rerender();
}

function selectAllTools(): void {
	editTools = [...availableTools];
	rerender();
}

function selectNoTools(): void {
	editTools = [];
	rerender();
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderListView() {
	if (loading) {
		return html`<div class="text-center py-8 text-muted-foreground text-sm">Loading…</div>`;
	}

	return html`
		<div class="flex flex-col gap-1">
			${roles.map((role) => {
				const acc = getAccessory(role.accessory);
				const toolText = role.allowedTools.length === 0 ? "All tools" : `${role.allowedTools.length} tool${role.allowedTools.length !== 1 ? "s" : ""}`;
				return html`
					<button
						class="flex items-center gap-3 w-full px-3 py-2.5 rounded-md hover:bg-secondary/70 transition-colors text-left group"
						@click=${() => showEdit(role)}
					>
						<span class="flex-shrink-0" style="width:18px;display:flex;align-items:center;justify-content:center;">
							${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory)}
						</span>
						<span class="flex-1 min-w-0">
							<span class="block text-sm font-medium truncate">${role.label}</span>
							<span class="block text-xs text-muted-foreground truncate">${role.name} · ${toolText}</span>
						</span>
						<span class="text-muted-foreground group-hover:text-foreground transition-colors">
							${icon(ChevronRight, "sm")}
						</span>
					</button>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT / CREATE VIEW
// ============================================================================

function renderEditView() {
	const isCreate = currentView === "create";
	const title = isCreate ? "New Role" : `Edit: ${selectedRole?.label || ""}`;

	const hasChanges = isCreate
		? editName.length > 0 && editLabel.length > 0
		: selectedRole && (
			editLabel !== selectedRole.label ||
			editPrompt !== selectedRole.promptTemplate ||
			JSON.stringify(editTools.sort()) !== JSON.stringify([...selectedRole.allowedTools].sort()) ||
			editAccessory !== selectedRole.accessory
		);

	return html`
		<div class="flex flex-col gap-4">
			<!-- Name field -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">Name</label>
				${isCreate
					? Input({
						value: editName,
						placeholder: "my-role (lowercase, hyphens ok)",
						onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; rerender(); },
					})
					: html`<div class="text-sm text-muted-foreground px-3 py-1.5 bg-secondary/30 rounded-md">${editName}</div>`
				}
			</div>

			<!-- Label field -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">Display Label</label>
				${Input({
					value: editLabel,
					placeholder: "e.g. Documentation Writer",
					onInput: (e: Event) => { editLabel = (e.target as HTMLInputElement).value; rerender(); },
				})}
			</div>

			<!-- System prompt -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1">System Prompt</label>
				<textarea
					class="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-[13px] outline-none focus:ring-1 focus:ring-ring resize-vertical"
					style="font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; min-height: 140px;"
					.value=${editPrompt}
					placeholder="Markdown system prompt template. Supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders."
					@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
				></textarea>
			</div>

			<!-- Tool selector -->
			<div>
				<div class="flex items-center gap-2 mb-1.5">
					<label class="text-[11px] text-muted-foreground">Allowed Tools</label>
					<span class="text-[10px] text-muted-foreground/60">(empty = all)</span>
					<span class="flex-1"></span>
					<button class="text-[10px] text-muted-foreground hover:text-foreground transition-colors" @click=${selectAllTools}>Select All</button>
					<button class="text-[10px] text-muted-foreground hover:text-foreground transition-colors" @click=${selectNoTools}>Select None</button>
				</div>
				<div class="flex flex-wrap gap-1.5">
					${availableTools.map((tool) => {
						const active = editTools.includes(tool);
						return html`
							<button
								class="px-2.5 py-1 rounded-md text-xs font-medium transition-all ${active
									? "bg-green-900/40 text-green-400 border border-green-700/50"
									: "bg-secondary/50 text-muted-foreground border border-border hover:border-muted-foreground/50"}"
								@click=${() => toggleTool(tool)}
							>${tool}</button>
						`;
					})}
				</div>
			</div>

			<!-- Accessory selector -->
			<div>
				<label class="block text-[11px] text-muted-foreground mb-1.5">Accessory</label>
				<div class="grid gap-1.5" style="grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));">
					${ACCESSORY_IDS.map((accId) => {
						const acc = getAccessory(accId);
						const selected = editAccessory === accId;
						return html`
							<button
								class="flex flex-col items-center gap-1 py-2 px-1 rounded-md border transition-all ${selected
									? "border-primary bg-secondary"
									: "border-transparent hover:bg-secondary/50"}"
								@click=${() => { editAccessory = accId; rerender(); }}
							>
								<span style="height:20px;display:flex;align-items:center;">
									${accId === "none"
										? html`<span class="text-xs text-muted-foreground">—</span>`
										: statusBobbit("idle", false, undefined, false, false, false, false, accId)}
								</span>
								<span class="text-[10px] ${selected ? "text-foreground" : "text-muted-foreground"}">${acc.label}</span>
							</button>
						`;
					})}
				</div>
			</div>

			<!-- Delete button (edit mode only) -->
			${!isCreate ? html`
				<div class="pt-2 border-t border-border/50">
					${Button({
						variant: "ghost" as any,
						onClick: handleDelete,
						disabled: deleting,
						className: "text-destructive hover:text-destructive hover:bg-destructive/10",
						children: html`${icon(Trash2, "sm")} ${deleting ? "Deleting…" : "Delete Role"}`,
					})}
				</div>
			` : nothing}
		</div>

		<!-- Save button in footer -->
		<div class="flex gap-2 justify-end pt-4">
			${Button({ variant: "ghost", onClick: showList, children: "Cancel" })}
			${Button({
				variant: "default",
				onClick: handleSave,
				disabled: saving || !hasChanges,
				children: saving ? "Saving…" : isCreate ? "Create Role" : "Save Changes",
			})}
		</div>
	`;
}

// ============================================================================
// MAIN DIALOG RENDER
// ============================================================================

function rerender(): void {
	if (!dialogContainer) return;

	const isListView = currentView === "list";
	const dialogTitle = isListView ? "Roles" : currentView === "create" ? "New Role" : `Edit: ${selectedRole?.label || ""}`;

	render(
		Dialog({
			isOpen: true,
			onClose: closeDialog,
			width: "min(520px, 92vw)",
			height: "min(680px, 90vh)",
			backdropClassName: "bg-black/50 backdrop-blur-sm",
			children: html`
				${DialogContent({
					children: html`
						<div class="flex items-center gap-2 mb-4">
							${!isListView ? html`
								<button
									class="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
									@click=${showList}
								>${icon(ArrowLeft, "sm")}</button>
							` : nothing}
							<span class="text-base font-semibold flex-1">${dialogTitle}</span>
							${isListView ? html`
								${Button({
									variant: "ghost",
									size: "sm",
									onClick: showCreate,
									children: html`${icon(Plus, "sm")} New Role`,
								})}
							` : nothing}
						</div>
						${isListView ? renderListView() : renderEditView()}
					`,
				})}
			`,
		}),
		dialogContainer,
	);
}

function closeDialog(): void {
	if (dialogContainer) {
		render(html``, dialogContainer);
		dialogContainer.remove();
		dialogContainer = null;
	}
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function showRoleManagerDialog(): void {
	// Reset state
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;

	dialogContainer = document.createElement("div");
	document.body.appendChild(dialogContainer);

	rerender();
	loadData();
}
