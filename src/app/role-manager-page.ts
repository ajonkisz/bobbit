import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2, Users } from "lucide";
import { fetchRoles, fetchTools, createRole, updateRole, deleteRole, gatewayFetch, type RoleData } from "./api.js";
import { ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

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

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadRolePageData(): Promise<void> {
	loading = true;
	renderApp();
	const [r, t] = await Promise.all([fetchRoles(), fetchTools()]);
	roles = r;
	availableTools = t;
	loading = false;
	renderApp();
}

export function clearRolePageState(): void {
	currentView = "list";
	selectedRole = null;
	loading = true;
	saving = false;
	deleting = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedRole = null;
	renderApp();
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
	renderApp();
}

async function createRoleAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ roleAssistant: true }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { isRoleAssistant: true });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create role assistant", msg);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	if (selectedRole) {
		const ok = await updateRole(selectedRole.name, {
			label: editLabel,
			promptTemplate: editPrompt,
			allowedTools: editTools,
			accessory: editAccessory,
		});
		if (ok) {
			const [r] = await Promise.all([fetchRoles()]);
			roles = r;
			const updated = roles.find((r) => r.name === selectedRole!.name);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
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
	renderApp();
	const ok = await deleteRole(selectedRole.name);
	if (ok) {
		const [r] = await Promise.all([fetchRoles()]);
		roles = r;
		showList();
	} else {
		deleting = false;
		renderApp();
	}
}

function toggleTool(tool: string): void {
	const idx = editTools.indexOf(tool);
	if (idx >= 0) {
		editTools = editTools.filter((t) => t !== tool);
	} else {
		editTools = [...editTools, tool];
	}
	renderApp();
}

function selectAllTools(): void {
	editTools = [...availableTools];
	renderApp();
}

function selectNoTools(): void {
	editTools = [];
	renderApp();
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	const title = currentView === "list" ? "Roles" : `Edit: ${selectedRole?.label || ""}`;

	return html`
		<div class="roles-nav">
			<div class="roles-nav-left">
				<button class="roles-back" @click=${() => currentView === "list" ? setHashRoute("landing") : showList()} title="${currentView === "list" ? "Back to sessions" : "Back to roles"}">
					${icon(ArrowLeft, "sm")}
				</button>
				<div class="roles-title-group">
					${currentView !== "list" && selectedRole ? html`
						<span class="roles-breadcrumb" @click=${showList}>Roles</span>
						<span class="roles-breadcrumb-sep">/</span>
					` : nothing}
					<h1 class="roles-title">${title}</h1>
				</div>
			</div>
			<div class="roles-nav-right">
				${currentView === "list" ? html`
					${Button({
						variant: "default",
						size: "sm",
						onClick: createRoleAssistantSession,
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} New Role</span>`,
					})}
				` : nothing}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: ROLE ROWS (list view)
// ============================================================================

async function handleDeleteFromList(role: RoleData): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Role",
		`Are you sure you want to delete "${role.label}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteRole(role.name);
	if (ok) {
		const [r] = await Promise.all([fetchRoles()]);
		roles = r;
		renderApp();
	}
}

function renderRoleRow(role: RoleData): TemplateResult {
	return html`
		<div class="role-row">
			<span class="role-row-avatar">
				${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory)}
			</span>
			<span class="role-row-label">${role.label}</span>
			<div class="role-row-actions">
				<button class="role-row-action-btn" @click=${() => showEdit(role)} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="role-row-action-btn delete" @click=${() => handleDeleteFromList(role)} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="roles-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading roles\u2026</span>
			</div>
		`;
	}

	if (roles.length === 0) {
		return html`
			<div class="roles-empty">
				<div class="roles-empty-icon">${icon(Users, "lg")}</div>
				<p>No roles defined yet</p>
				${Button({
					variant: "default",
					onClick: createRoleAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first role</span>`,
				})}
			</div>
		`;
	}

	return html`
		<div class="roles-list">
			${roles.map(renderRoleRow)}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	const hasChanges = selectedRole && (
		editLabel !== selectedRole.label ||
		editPrompt !== selectedRole.promptTemplate ||
		JSON.stringify(editTools.sort()) !== JSON.stringify([...selectedRole.allowedTools].sort()) ||
		editAccessory !== selectedRole.accessory
	);

	return html`
		<div class="roles-edit-container">
			<div class="roles-edit-main">
				<!-- Identity section -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">Identity</h2>
					<div class="roles-edit-field">
						<label class="roles-field-label">Name</label>
						<div class="roles-field-readonly">${editName}</div>
					</div>
					<div class="roles-edit-field">
						<label class="roles-field-label">Display Label</label>
						${Input({
							value: editLabel,
							placeholder: "e.g. Documentation Writer",
							onInput: (e: Event) => { editLabel = (e.target as HTMLInputElement).value; renderApp(); },
						})}
					</div>
				</div>

				<!-- System prompt section -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">System Prompt</h2>
					<textarea
						class="roles-prompt-editor"
						.value=${editPrompt}
						placeholder="Markdown system prompt template. Supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders."
						@input=${(e: Event) => { editPrompt = (e.target as HTMLTextAreaElement).value; }}
					></textarea>
				</div>

				<!-- Tools section -->
				<div class="roles-edit-section">
					<div class="roles-tools-header">
						<h2 class="roles-section-title">Allowed Tools</h2>
						<span class="roles-tools-hint">(empty = all tools)</span>
						<span class="flex-1"></span>
						<button class="roles-tools-action" @click=${selectAllTools}>Select All</button>
						<button class="roles-tools-action" @click=${selectNoTools}>Select None</button>
					</div>
					<div class="roles-tools-grid">
						${availableTools.map((tool) => {
							const active = editTools.includes(tool);
							return html`
								<button
									class="roles-tool-chip ${active ? "roles-tool-chip--active" : ""}"
									@click=${() => toggleTool(tool)}
								>${active ? "\u2713 " : ""}${tool}</button>
							`;
						})}
					</div>
				</div>
			</div>

			<!-- Right sidebar -->
			<div class="roles-edit-sidebar">
				<!-- Accessory selector -->
				<div class="roles-edit-section">
					<h2 class="roles-section-title">Accessory</h2>
					<div class="roles-accessory-grid">
						${ACCESSORY_IDS.map((accId) => {
							const acc = getAccessory(accId);
							const selected = editAccessory === accId;
							return html`
								<button
									class="roles-accessory-option ${selected ? "roles-accessory-option--selected" : ""}"
									@click=${() => { editAccessory = accId; renderApp(); }}
								>
									<span class="roles-accessory-preview">
										${accId === "none"
											? html`<span class="text-xs text-muted-foreground">\u2014</span>`
											: statusBobbit("idle", false, undefined, false, false, false, false, accId)}
									</span>
									<span class="roles-accessory-label">${acc.label}</span>
								</button>
							`;
						})}
					</div>
				</div>

				<!-- Actions -->
				<div class="roles-edit-section roles-edit-actions">
					${Button({
						variant: "default",
						onClick: handleSave,
						disabled: saving || !hasChanges,
						children: saving ? "Saving\u2026" : "Save Changes",
					})}
					<div class="roles-danger-zone">
						${Button({
							variant: "ghost" as any,
							onClick: handleDelete,
							disabled: deleting,
							className: "text-destructive hover:text-destructive hover:bg-destructive/10",
							children: html`${icon(Trash2, "sm")} ${deleting ? "Deleting\u2026" : "Delete Role"}`,
						})}
					</div>
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderRoleManagerPage(): TemplateResult {
	return html`
		<div class="roles-container">
			${renderNavBar()}
			<div class="roles-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
