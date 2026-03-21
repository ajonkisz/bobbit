import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide";
import {
	fetchArtifactSpecs,
	createArtifactSpec,
	updateArtifactSpec,
	deleteArtifactSpec,
	gatewayFetch,
	type ArtifactSpec,
	type ArtifactKind,
	type ArtifactFormat,
} from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const KIND_COLORS: Record<ArtifactKind, string> = {
	analysis: "#60a5fa",
	deliverable: "#34d399",
	review: "#fbbf24",
	verification: "#a78bfa",
};

const KIND_LABELS: Record<ArtifactKind, string> = {
	analysis: "Analysis",
	deliverable: "Deliverable",
	review: "Review",
	verification: "Verification",
};

const KIND_ORDER: ArtifactKind[] = ["analysis", "deliverable", "review", "verification"];
const FORMAT_OPTIONS: ArtifactFormat[] = ["markdown", "html", "diff", "command"];

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let specs: ArtifactSpec[] = [];
let selectedSpec: ArtifactSpec | null = null;
let loading = true;

// Edit form state
let editId = "";
let editName = "";
let editDescription = "";
let editKind: ArtifactKind = "analysis";
let editFormat: ArtifactFormat = "markdown";
let editMustHave: string[] = [];
let editShouldHave: string[] = [];
let editMustNotHave: string[] = [];
let editRequires: string[] = [];
let editSuggestedRole = "";

let saving = false;
let deleting = false;

// Temp inputs for adding criteria
let addMustHave = "";
let addShouldHave = "";
let addMustNotHave = "";

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadArtifactSpecPageData(): Promise<void> {
	currentView = "list";
	selectedSpec = null;
	loading = true;
	saving = false;
	deleting = false;
	renderApp();
	specs = await fetchArtifactSpecs();
	loading = false;
	renderApp();
}

export function clearArtifactSpecPageState(): void {
	currentView = "list";
	selectedSpec = null;
	loading = true;
	saving = false;
	deleting = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedSpec = null;
	setHashRoute("artifact-specs");
}

function showEdit(spec: ArtifactSpec): void {
	currentView = "edit";
	selectedSpec = spec;
	editId = spec.id;
	editName = spec.name;
	editDescription = spec.description;
	editKind = spec.kind;
	editFormat = spec.format;
	editMustHave = [...spec.mustHave];
	editShouldHave = [...spec.shouldHave];
	editMustNotHave = [...spec.mustNotHave];
	editRequires = [...(spec.requires || [])];
	editSuggestedRole = spec.suggestedRole || "";
	saving = false;
	deleting = false;
	addMustHave = "";
	addShouldHave = "";
	addMustNotHave = "";
	setHashRoute("artifact-spec-edit", spec.id);
}

export function navigateToArtifactSpecEdit(specId: string): void {
	const spec = specs.find((s) => s.id === specId);
	if (spec) {
		showEdit(spec);
	} else {
		currentView = "list";
		selectedSpec = null;
	}
	renderApp();
}

async function createAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "artifact-spec" }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { assistantType: "artifact-spec" });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		showConnectionError("Failed to create artifact spec assistant", err instanceof Error ? err.message : String(err));
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

	if (selectedSpec) {
		const ok = await updateArtifactSpec(selectedSpec.id, {
			name: editName,
			description: editDescription,
			kind: editKind,
			format: editFormat,
			mustHave: editMustHave,
			shouldHave: editShouldHave,
			mustNotHave: editMustNotHave,
			requires: editRequires.length > 0 ? editRequires : undefined,
			suggestedRole: editSuggestedRole || undefined,
		});
		if (ok) {
			specs = await fetchArtifactSpecs();
			const updated = specs.find((s) => s.id === selectedSpec!.id);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(): Promise<void> {
	if (!selectedSpec) return;
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Artifact Spec",
		`Are you sure you want to delete "${selectedSpec.name}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	deleting = true;
	renderApp();
	const ok = await deleteArtifactSpec(selectedSpec.id);
	if (ok) {
		specs = await fetchArtifactSpecs();
		showList();
	} else {
		deleting = false;
		renderApp();
	}
}

async function handleDeleteFromList(spec: ArtifactSpec): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Artifact Spec",
		`Are you sure you want to delete "${spec.name}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteArtifactSpec(spec.id);
	if (ok) {
		specs = await fetchArtifactSpecs();
		renderApp();
	}
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView !== "list" && selectedSpec) {
		const hasChanges = selectedSpec && (
			editName !== selectedSpec.name ||
			editDescription !== selectedSpec.description ||
			editKind !== selectedSpec.kind ||
			editFormat !== selectedSpec.format ||
			JSON.stringify(editMustHave) !== JSON.stringify(selectedSpec.mustHave) ||
			JSON.stringify(editShouldHave) !== JSON.stringify(selectedSpec.shouldHave) ||
			JSON.stringify(editMustNotHave) !== JSON.stringify(selectedSpec.mustNotHave) ||
			JSON.stringify(editRequires) !== JSON.stringify(selectedSpec.requires || []) ||
			editSuggestedRole !== (selectedSpec.suggestedRole || "")
		);
		return html`
			<div class="artifact-specs-nav">
				<div class="artifact-specs-nav-left">
					<button class="artifact-specs-back" @click=${showList} title="Back to specs">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="artifact-specs-title-group">
						<span class="artifact-specs-breadcrumb" @click=${showList}>Artifact Specs</span>
						<span class="artifact-specs-breadcrumb-sep">/</span>
						<h1 class="artifact-specs-title">${selectedSpec.name}</h1>
					</div>
				</div>
				<div class="artifact-specs-nav-right">
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: handleDelete,
						disabled: deleting,
						className: "text-destructive hover:text-destructive hover:bg-destructive/10",
						children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} ${deleting ? "Deleting\u2026" : "Delete"}</span>`,
					})}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || !hasChanges,
						children: saving ? "Saving\u2026" : "Save",
					})}
				</div>
			</div>
		`;
	}

	return html`
		<div class="artifact-specs-nav">
			<div class="artifact-specs-nav-left">
				<button class="artifact-specs-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="artifact-specs-title">Artifact Specs</h1>
			</div>
			<div class="artifact-specs-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: createAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Spec</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderSpecRow(spec: ArtifactSpec): TemplateResult {
	const color = KIND_COLORS[spec.kind] || "#888";
	return html`
		<div class="artifact-spec-row" tabindex="0" role="button"
			@click=${() => showEdit(spec)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(spec); } }}>
			<span class="artifact-specs-kind-dot" style="background:${color}"></span>
			<div class="artifact-spec-row-info">
				<span class="artifact-spec-row-name">${spec.name}</span>
				<span class="artifact-spec-row-desc">${spec.description}</span>
			</div>
			<div class="artifact-spec-row-badges">
				<span class="artifact-spec-format-badge">${spec.format}</span>
				${spec.requires?.length ? html`<span class="artifact-spec-format-badge">${spec.requires.length} dep${spec.requires.length > 1 ? "s" : ""}</span>` : nothing}
			</div>
			<div class="artifact-spec-row-actions">
				<button class="artifact-spec-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(spec); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="artifact-spec-row-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDeleteFromList(spec); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="artifact-specs-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading specs\u2026</span>
			</div>
		`;
	}

	if (specs.length === 0) {
		return html`
			<div class="artifact-specs-empty">
				<p class="artifact-specs-empty-title">No artifact specs yet</p>
				<p class="artifact-specs-empty-desc">Artifact specs define structured outputs that agents produce, with quality criteria and dependency chains.</p>
				${Button({
					variant: "default",
					onClick: createAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first spec</span>`,
				})}
			</div>
		`;
	}

	// Group by kind
	const grouped = new Map<ArtifactKind, ArtifactSpec[]>();
	for (const spec of specs) {
		const list = grouped.get(spec.kind) || [];
		list.push(spec);
		grouped.set(spec.kind, list);
	}

	return html`
		<div class="artifact-specs-list">
			${KIND_ORDER.filter((k) => grouped.has(k)).map((kind) => html`
				<div class="artifact-specs-group-header">
					<span class="artifact-specs-kind-dot" style="background:${KIND_COLORS[kind]}"></span>
					${KIND_LABELS[kind]}
				</div>
				${grouped.get(kind)!.map((spec) => renderSpecRow(spec))}
			`)}
		</div>
	`;
}

// ============================================================================
// RENDER: CRITERIA LIST EDITOR
// ============================================================================

function renderCriteriaList(
	label: string,
	items: string[],
	onRemove: (index: number) => void,
	inputValue: string,
	onInputChange: (value: string) => void,
	onAdd: () => void,
): TemplateResult {
	return html`
		<div class="artifact-specs-edit-section">
			<h2 class="artifact-specs-section-title">${label}</h2>
			<div class="artifact-specs-criteria-list">
				${items.map((item, i) => html`
					<div class="artifact-specs-criteria-item">
						<span class="artifact-specs-criteria-item-text">${item}</span>
						<button class="artifact-specs-criteria-remove" @click=${() => onRemove(i)} title="Remove">&times;</button>
					</div>
				`)}
			</div>
			<div class="artifact-specs-criteria-add">
				<input class="artifact-specs-criteria-input"
					.value=${inputValue}
					placeholder="Add item..."
					@input=${(e: Event) => onInputChange((e.target as HTMLInputElement).value)}
					@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && inputValue.trim()) { e.preventDefault(); onAdd(); } }}
				/>
				<button class="artifact-specs-criteria-add-btn" @click=${onAdd} ?disabled=${!inputValue.trim()}>Add</button>
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	// Get other spec IDs for the requires checkboxes
	const otherSpecs = specs.filter((s) => s.id !== editId);

	return html`
		<div class="artifact-specs-edit-container">
			<div class="artifact-specs-edit-main">
				<!-- Identity -->
				<div class="artifact-specs-edit-section">
					<h2 class="artifact-specs-section-title">Identity</h2>
					<div class="artifact-specs-identity-row">
						<div class="artifact-specs-edit-field">
							<label class="artifact-specs-field-label">Id</label>
							<div class="artifact-specs-field-readonly">${editId}</div>
						</div>
						<div class="artifact-specs-edit-field" style="flex:1;min-width:0;">
							<label class="artifact-specs-field-label">Name</label>
							${Input({
								value: editName,
								placeholder: "e.g. Design Document",
								onInput: (e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); },
							})}
						</div>
					</div>
				</div>

				<!-- Classification -->
				<div class="artifact-specs-edit-section">
					<h2 class="artifact-specs-section-title">Classification</h2>
					<div class="artifact-specs-identity-row">
						<div class="artifact-specs-edit-field" style="flex:1;">
							<label class="artifact-specs-field-label">Kind</label>
							<select class="artifact-specs-select"
								.value=${editKind}
								@change=${(e: Event) => { editKind = (e.target as HTMLSelectElement).value as ArtifactKind; renderApp(); }}>
								${KIND_ORDER.map((k) => html`<option value=${k} ?selected=${editKind === k}>${KIND_LABELS[k]}</option>`)}
							</select>
						</div>
						<div class="artifact-specs-edit-field" style="flex:1;">
							<label class="artifact-specs-field-label">Format</label>
							<select class="artifact-specs-select"
								.value=${editFormat}
								@change=${(e: Event) => { editFormat = (e.target as HTMLSelectElement).value as ArtifactFormat; renderApp(); }}>
								${FORMAT_OPTIONS.map((f) => html`<option value=${f} ?selected=${editFormat === f}>${f}</option>`)}
							</select>
						</div>
					</div>
				</div>

				<!-- Description -->
				<div class="artifact-specs-edit-section">
					<h2 class="artifact-specs-section-title">Description</h2>
					<textarea class="artifact-specs-desc-editor"
						.value=${editDescription}
						placeholder="What this artifact is and why it matters"
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; }}
					></textarea>
				</div>

				<!-- Quality Criteria -->
				${renderCriteriaList("Must Have", editMustHave,
					(i) => { editMustHave = editMustHave.filter((_, idx) => idx !== i); renderApp(); },
					addMustHave,
					(v) => { addMustHave = v; renderApp(); },
					() => { if (addMustHave.trim()) { editMustHave = [...editMustHave, addMustHave.trim()]; addMustHave = ""; renderApp(); } },
				)}

				${renderCriteriaList("Should Have", editShouldHave,
					(i) => { editShouldHave = editShouldHave.filter((_, idx) => idx !== i); renderApp(); },
					addShouldHave,
					(v) => { addShouldHave = v; renderApp(); },
					() => { if (addShouldHave.trim()) { editShouldHave = [...editShouldHave, addShouldHave.trim()]; addShouldHave = ""; renderApp(); } },
				)}

				${renderCriteriaList("Must Not Have", editMustNotHave,
					(i) => { editMustNotHave = editMustNotHave.filter((_, idx) => idx !== i); renderApp(); },
					addMustNotHave,
					(v) => { addMustNotHave = v; renderApp(); },
					() => { if (addMustNotHave.trim()) { editMustNotHave = [...editMustNotHave, addMustNotHave.trim()]; addMustNotHave = ""; renderApp(); } },
				)}
			</div>

			<!-- Sidebar -->
			<div class="artifact-specs-edit-sidebar">
				<!-- Dependencies -->
				<div class="artifact-specs-edit-section">
					<h2 class="artifact-specs-section-title">Requires</h2>
					<p style="font-size:12px;color:var(--muted-foreground);margin:0 0 4px;">Other specs that must have artifacts before this one can be created.</p>
					<div class="artifact-specs-requires-list">
						${otherSpecs.map((s) => html`
							<label class="artifact-specs-requires-item">
								<input type="checkbox"
									.checked=${editRequires.includes(s.id)}
									@change=${(e: Event) => {
										const checked = (e.target as HTMLInputElement).checked;
										if (checked) {
											editRequires = [...editRequires, s.id];
										} else {
											editRequires = editRequires.filter((r) => r !== s.id);
										}
										renderApp();
									}}
								/>
								<span>${s.name}</span>
								<span style="font-size:11px;color:var(--muted-foreground);">(${s.id})</span>
							</label>
						`)}
						${otherSpecs.length === 0 ? html`<span style="font-size:12px;color:var(--muted-foreground);">No other specs available</span>` : nothing}
					</div>
				</div>

				<!-- Suggested Role -->
				<div class="artifact-specs-edit-section">
					<h2 class="artifact-specs-section-title">Suggested Role</h2>
					${Input({
						value: editSuggestedRole,
						placeholder: "e.g. reviewer",
						onInput: (e: Event) => { editSuggestedRole = (e.target as HTMLInputElement).value; renderApp(); },
					})}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderArtifactSpecPage(): TemplateResult {
	return html`
		<div class="artifact-specs-container">
			${renderNavBar()}
			<div class="artifact-specs-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
