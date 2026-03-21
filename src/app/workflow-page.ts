import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, Copy, Pencil, Plus, Trash2 } from "lucide";
import {
	fetchWorkflows,
	fetchWorkflow,
	createWorkflow,
	updateWorkflow,
	deleteWorkflow,
	cloneWorkflow,
	type Workflow,
	type WorkflowArtifact,
} from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const KIND_OPTIONS = ["analysis", "deliverable", "review", "verification"] as const;
const FORMAT_OPTIONS = ["markdown", "html", "diff", "command"] as const;

const KIND_COLORS: Record<string, string> = {
	analysis: "#60a5fa",
	deliverable: "#34d399",
	review: "#fbbf24",
	verification: "#a78bfa",
};

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let workflows: Workflow[] = [];
let selectedWorkflow: Workflow | null = null;
let loading = true;
let saving = false;
let isNew = false;

// Edit form state
let editId = "";
let editName = "";
let editDescription = "";
let editArtifacts: WorkflowArtifact[] = [];

// Temp criteria inputs per artifact index
let addMustHave: Record<number, string> = {};
let addShouldHave: Record<number, string> = {};
let addMustNotHave: Record<number, string> = {};

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadWorkflowPageData(): Promise<void> {
	currentView = "list";
	selectedWorkflow = null;
	loading = true;
	saving = false;
	isNew = false;
	renderApp();
	workflows = await fetchWorkflows();
	loading = false;
	renderApp();
}

export function clearWorkflowPageState(): void {
	currentView = "list";
	selectedWorkflow = null;
	loading = true;
	saving = false;
	isNew = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedWorkflow = null;
	isNew = false;
	setHashRoute("workflows");
}

function showEdit(workflow: Workflow): void {
	currentView = "edit";
	selectedWorkflow = workflow;
	isNew = false;
	editId = workflow.id;
	editName = workflow.name;
	editDescription = workflow.description;
	editArtifacts = workflow.artifacts.map((a) => ({ ...a, dependsOn: [...a.dependsOn], mustHave: [...a.mustHave], shouldHave: [...a.shouldHave], mustNotHave: [...a.mustNotHave] }));
	saving = false;
	addMustHave = {};
	addShouldHave = {};
	addMustNotHave = {};
	setHashRoute("workflow-edit", workflow.id);
}

function showNewEdit(): void {
	currentView = "edit";
	selectedWorkflow = null;
	isNew = true;
	editId = "";
	editName = "";
	editDescription = "";
	editArtifacts = [];
	saving = false;
	addMustHave = {};
	addShouldHave = {};
	addMustNotHave = {};
	renderApp();
}

export function navigateToWorkflowEdit(workflowId: string): void {
	const wf = workflows.find((w) => w.id === workflowId);
	if (wf) {
		showEdit(wf);
	} else {
		currentView = "list";
		selectedWorkflow = null;
	}
	renderApp();
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	saving = true;
	renderApp();

	if (isNew) {
		const result = await createWorkflow({
			id: editId,
			name: editName,
			description: editDescription,
			artifacts: editArtifacts,
		});
		if (result) {
			workflows = await fetchWorkflows();
			showEdit(result);
			return;
		}
	} else if (selectedWorkflow) {
		const ok = await updateWorkflow(selectedWorkflow.id, {
			name: editName,
			description: editDescription,
			artifacts: editArtifacts,
		});
		if (ok) {
			workflows = await fetchWorkflows();
			const updated = workflows.find((w) => w.id === selectedWorkflow!.id);
			if (updated) showEdit(updated);
			else showList();
			return;
		}
	}
	saving = false;
	renderApp();
}

async function handleDelete(workflow: Workflow): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const confirmed = await confirmAction(
		"Delete Workflow",
		`Are you sure you want to delete "${workflow.name}"? This cannot be undone.`,
		"Delete",
		true,
	);
	if (!confirmed) return;

	const ok = await deleteWorkflow(workflow.id);
	if (ok) {
		workflows = await fetchWorkflows();
		if (selectedWorkflow?.id === workflow.id) {
			showList();
		}
		renderApp();
	}
}

async function handleClone(workflow: Workflow): Promise<void> {
	const result = await cloneWorkflow(workflow.id);
	if (result) {
		workflows = await fetchWorkflows();
		showEdit(result);
	}
}

function addArtifact(): void {
	editArtifacts = [...editArtifacts, {
		id: "",
		name: "",
		description: "",
		kind: "analysis",
		format: "markdown",
		dependsOn: [],
		mustHave: [],
		shouldHave: [],
		mustNotHave: [],
	}];
	renderApp();
}

function removeArtifact(index: number): void {
	editArtifacts = editArtifacts.filter((_, i) => i !== index);
	renderApp();
}

function updateArtifactField(index: number, field: string, value: any): void {
	editArtifacts = editArtifacts.map((a, i) => i === index ? { ...a, [field]: value } : a);
	renderApp();
}

// ============================================================================
// RENDER: CRITERIA EDITOR (inline)
// ============================================================================

function renderCriteria(label: string, items: string[], artIdx: number, store: Record<number, string>, onAdd: (idx: number, val: string) => void, onRemove: (idx: number, itemIdx: number) => void): TemplateResult {
	const inputValue = store[artIdx] || "";
	return html`
		<div class="wf-criteria-section">
			<div class="wf-criteria-label">${label}</div>
			<div class="wf-criteria-list">
				${items.map((item, i) => html`
					<div class="wf-criteria-item">
						<span class="wf-criteria-text">${item}</span>
						<button class="wf-criteria-remove" @click=${() => onRemove(artIdx, i)}>&times;</button>
					</div>
				`)}
			</div>
			<div class="wf-criteria-add-row">
				<input class="wf-criteria-input"
					.value=${inputValue}
					placeholder="Add item..."
					@input=${(e: Event) => { store[artIdx] = (e.target as HTMLInputElement).value; renderApp(); }}
					@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && inputValue.trim()) { e.preventDefault(); onAdd(artIdx, inputValue.trim()); store[artIdx] = ""; renderApp(); } }}
				/>
				<button class="wf-criteria-add-btn" @click=${() => { if (inputValue.trim()) { onAdd(artIdx, inputValue.trim()); store[artIdx] = ""; renderApp(); } }} ?disabled=${!inputValue.trim()}>Add</button>
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit") {
		const title = isNew ? "New Workflow" : selectedWorkflow?.name || "Edit";
		return html`
			<div class="wf-nav">
				<div class="wf-nav-left">
					<button class="wf-back" @click=${showList} title="Back to workflows">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="wf-title-group">
						<span class="wf-breadcrumb" @click=${showList}>Workflows</span>
						<span class="wf-breadcrumb-sep">/</span>
						<h1 class="wf-title">${title}</h1>
					</div>
				</div>
				<div class="wf-nav-right">
					${!isNew && selectedWorkflow ? html`
						${Button({
							variant: "ghost" as any,
							size: "sm",
							onClick: () => handleDelete(selectedWorkflow!),
							className: "text-destructive hover:text-destructive hover:bg-destructive/10",
							children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "sm")} Delete</span>`,
						})}
					` : nothing}
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleSave,
						disabled: saving || (!editId.trim() && isNew) || !editName.trim(),
						children: saving ? "Saving\u2026" : "Save",
					})}
				</div>
			</div>
		`;
	}

	return html`
		<div class="wf-nav">
			<div class="wf-nav-left">
				<button class="wf-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="wf-title">Workflows</h1>
			</div>
			<div class="wf-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: showNewEdit,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Workflow</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderWorkflowRow(wf: Workflow): TemplateResult {
	const kindBreakdown = new Map<string, number>();
	for (const a of wf.artifacts) {
		kindBreakdown.set(a.kind, (kindBreakdown.get(a.kind) || 0) + 1);
	}

	return html`
		<div class="wf-row" tabindex="0" role="button"
			@click=${() => showEdit(wf)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(wf); } }}>
			<div class="wf-row-info">
				<span class="wf-row-name">${wf.name}</span>
				<span class="wf-row-desc">${wf.description}</span>
			</div>
			<div class="wf-row-badges">
				<span class="wf-badge">${wf.artifacts.length} artifact${wf.artifacts.length !== 1 ? "s" : ""}</span>
				${Array.from(kindBreakdown.entries()).map(([kind, count]) => html`
					<span class="wf-kind-badge" style="background:${KIND_COLORS[kind] || "#888"}20;color:${KIND_COLORS[kind] || "#888"}">${count} ${kind}</span>
				`)}
			</div>
			<div class="wf-row-actions">
				<button class="wf-action-btn" @click=${(e: Event) => { e.stopPropagation(); handleClone(wf); }} title="Clone">
					${icon(Copy, "sm")}
				</button>
				<button class="wf-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(wf); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
				<button class="wf-action-btn delete" @click=${(e: Event) => { e.stopPropagation(); handleDelete(wf); }} title="Delete">
					${icon(Trash2, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="wf-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading workflows\u2026</span>
			</div>
		`;
	}

	if (workflows.length === 0) {
		return html`
			<div class="wf-empty">
				<p class="wf-empty-title">No workflows yet</p>
				<p class="wf-empty-desc">Workflows define the artifacts a goal must produce, their dependency relationships, and how each is verified.</p>
				${Button({
					variant: "default",
					onClick: showNewEdit,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Create your first workflow</span>`,
				})}
			</div>
		`;
	}

	return html`
		<div class="wf-list">
			${workflows.map((wf) => renderWorkflowRow(wf))}
		</div>
	`;
}

// ============================================================================
// RENDER: VERIFICATION CONFIG
// ============================================================================

const VERIFICATION_TYPES = ["none", "command", "llm-review", "combined"] as const;

function renderVerificationConfig(art: WorkflowArtifact, idx: number): TemplateResult {
	const vType = art.verification?.type || "none";

	return html`
		<div class="wf-criteria-section">
			<div class="wf-criteria-label">Verification</div>
			<div class="wf-field-row" style="margin-bottom:0.5rem;">
				<div class="wf-field" style="flex:0 0 180px;">
					<label class="wf-field-label">Type</label>
					<select class="wf-select" .value=${vType}
						@change=${(e: Event) => {
							const newType = (e.target as HTMLSelectElement).value;
							if (newType === "none") {
								updateArtifactField(idx, "verification", undefined);
							} else if (newType === "command") {
								updateArtifactField(idx, "verification", { type: "command", command: "", timeout: 300 });
							} else if (newType === "llm-review") {
								updateArtifactField(idx, "verification", { type: "llm-review", prompt: "", timeout: 600 });
							} else {
								updateArtifactField(idx, "verification", { type: "combined", steps: [] });
							}
						}}>
						${VERIFICATION_TYPES.map((t) => html`<option value=${t} ?selected=${vType === t}>${t === "none" ? "None" : t}</option>`)}
					</select>
				</div>
				${vType !== "none" && vType !== "combined" ? html`
					<div class="wf-field" style="flex:0 0 100px;">
						<label class="wf-field-label">Timeout (s)</label>
						<input class="wf-input" type="number" .value=${String(art.verification?.timeout || (vType === "command" ? 300 : 600))}
							@input=${(e: Event) => {
								const v = art.verification || { type: vType };
								updateArtifactField(idx, "verification", { ...v, timeout: parseInt((e.target as HTMLInputElement).value) || 300 });
							}} />
					</div>
				` : nothing}
			</div>
			${vType === "command" ? html`
				<div class="wf-field">
					<label class="wf-field-label">Command</label>
					<input class="wf-input" .value=${art.verification?.command || ""} placeholder="e.g. npm run check"
						@input=${(e: Event) => {
							const v = art.verification || { type: "command" };
							updateArtifactField(idx, "verification", { ...v, command: (e.target as HTMLInputElement).value });
						}} />
					<div class="wf-field-hint">Variables: {{command}}, {{branch}}, {{master}}, {{cwd}}</div>
				</div>
			` : nothing}
			${vType === "llm-review" ? html`
				<div class="wf-field">
					<label class="wf-field-label">Review Prompt</label>
					<textarea class="wf-textarea" .value=${art.verification?.prompt || ""} placeholder="Describe what to review and verify..."
						@input=${(e: Event) => {
							const v = art.verification || { type: "llm-review" };
							updateArtifactField(idx, "verification", { ...v, prompt: (e.target as HTMLTextAreaElement).value });
						}}></textarea>
				</div>
			` : nothing}
			${vType === "combined" ? html`
				<div class="wf-verification-steps">
					${(art.verification?.steps || []).map((step: any, si: number) => html`
						<div class="wf-verification-step">
							<div class="wf-field-row">
								<div class="wf-field" style="flex:1;">
									<input class="wf-input" .value=${step.name || ""} placeholder="Step name"
										@input=${(e: Event) => {
											const steps = [...(art.verification?.steps || [])];
											steps[si] = { ...steps[si], name: (e.target as HTMLInputElement).value };
											updateArtifactField(idx, "verification", { ...art.verification, steps });
										}} />
								</div>
								<div class="wf-field" style="flex:0 0 140px;">
									<select class="wf-select" .value=${step.type || "command"}
										@change=${(e: Event) => {
											const steps = [...(art.verification?.steps || [])];
											steps[si] = { ...steps[si], type: (e.target as HTMLSelectElement).value };
											updateArtifactField(idx, "verification", { ...art.verification, steps });
										}}>
										<option value="command" ?selected=${step.type === "command"}>command</option>
										<option value="llm-review" ?selected=${step.type === "llm-review"}>llm-review</option>
									</select>
								</div>
								<div class="wf-field" style="flex:0 0 80px;">
									<input class="wf-input" type="number" .value=${String(step.timeout || 300)} placeholder="Timeout"
										@input=${(e: Event) => {
											const steps = [...(art.verification?.steps || [])];
											steps[si] = { ...steps[si], timeout: parseInt((e.target as HTMLInputElement).value) || 300 };
											updateArtifactField(idx, "verification", { ...art.verification, steps });
										}} />
								</div>
								<button class="wf-criteria-remove" @click=${() => {
									const steps = (art.verification?.steps || []).filter((_: any, i: number) => i !== si);
									updateArtifactField(idx, "verification", { ...art.verification, steps });
								}}>&times;</button>
							</div>
							${step.type === "command" ? html`
								<input class="wf-input" style="margin-top:4px;" .value=${step.command || ""} placeholder="Command..."
									@input=${(e: Event) => {
										const steps = [...(art.verification?.steps || [])];
										steps[si] = { ...steps[si], command: (e.target as HTMLInputElement).value };
										updateArtifactField(idx, "verification", { ...art.verification, steps });
									}} />
							` : html`
								<textarea class="wf-textarea" style="margin-top:4px;" .value=${step.prompt || ""} placeholder="Review prompt..."
									@input=${(e: Event) => {
										const steps = [...(art.verification?.steps || [])];
										steps[si] = { ...steps[si], prompt: (e.target as HTMLTextAreaElement).value };
										updateArtifactField(idx, "verification", { ...art.verification, steps });
									}}></textarea>
							`}
						</div>
					`)}
					<button class="wf-criteria-add-btn" @click=${() => {
						const steps = [...(art.verification?.steps || []), { name: "", type: "command", command: "", timeout: 300 }];
						updateArtifactField(idx, "verification", { ...art.verification, steps });
					}}>Add Step</button>
				</div>
			` : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: ARTIFACT EDITOR
// ============================================================================

function renderArtifactEditor(art: WorkflowArtifact, idx: number): TemplateResult {
	const otherIds = editArtifacts.filter((_, i) => i !== idx).map((a) => a.id).filter(Boolean);
	const color = KIND_COLORS[art.kind] || "#888";

	return html`
		<div class="wf-artifact-card">
			<div class="wf-artifact-header">
				<span class="wf-artifact-idx" style="background:${color}20;color:${color}">${idx + 1}</span>
				<span class="wf-artifact-id-label">${art.id || "(no id)"}</span>
				<button class="wf-artifact-remove" @click=${() => removeArtifact(idx)} title="Remove artifact">${icon(Trash2, "sm")}</button>
			</div>

			<div class="wf-artifact-fields">
				<div class="wf-field-row">
					<div class="wf-field" style="flex:0 0 160px;">
						<label class="wf-field-label">ID</label>
						<input class="wf-input" .value=${art.id} placeholder="e.g. issue-analysis"
							@input=${(e: Event) => updateArtifactField(idx, "id", (e.target as HTMLInputElement).value)} />
					</div>
					<div class="wf-field" style="flex:1;min-width:0;">
						<label class="wf-field-label">Name</label>
						<input class="wf-input" .value=${art.name} placeholder="Display name"
							@input=${(e: Event) => updateArtifactField(idx, "name", (e.target as HTMLInputElement).value)} />
					</div>
				</div>

				<div class="wf-field-row">
					<div class="wf-field" style="flex:1;">
						<label class="wf-field-label">Kind</label>
						<select class="wf-select" .value=${art.kind}
							@change=${(e: Event) => updateArtifactField(idx, "kind", (e.target as HTMLSelectElement).value)}>
							${KIND_OPTIONS.map((k) => html`<option value=${k} ?selected=${art.kind === k}>${k}</option>`)}
						</select>
					</div>
					<div class="wf-field" style="flex:1;">
						<label class="wf-field-label">Format</label>
						<select class="wf-select" .value=${art.format}
							@change=${(e: Event) => updateArtifactField(idx, "format", (e.target as HTMLSelectElement).value)}>
							${FORMAT_OPTIONS.map((f) => html`<option value=${f} ?selected=${art.format === f}>${f}</option>`)}
						</select>
					</div>
					<div class="wf-field" style="flex:1;">
						<label class="wf-field-label">Suggested Role</label>
						<input class="wf-input" .value=${art.suggestedRole || ""} placeholder="e.g. coder"
							@input=${(e: Event) => updateArtifactField(idx, "suggestedRole", (e.target as HTMLInputElement).value || undefined)} />
					</div>
				</div>

				<div class="wf-field">
					<label class="wf-field-label">Description</label>
					<textarea class="wf-textarea" .value=${art.description} placeholder="What this artifact is and why it matters"
						@input=${(e: Event) => updateArtifactField(idx, "description", (e.target as HTMLTextAreaElement).value)}></textarea>
				</div>

				<div class="wf-field">
					<label class="wf-field-label">Depends On</label>
					<div class="wf-dep-list">
						${otherIds.length > 0 ? otherIds.map((depId) => {
							const checked = art.dependsOn.includes(depId);
							return html`
								<label class="wf-dep-item">
									<input type="checkbox" .checked=${checked}
										@change=${(e: Event) => {
											const c = (e.target as HTMLInputElement).checked;
											const newDeps = c ? [...art.dependsOn, depId] : art.dependsOn.filter((d) => d !== depId);
											updateArtifactField(idx, "dependsOn", newDeps);
										}} />
									<span>${depId}</span>
								</label>
							`;
						}) : html`<span class="wf-dep-none">No other artifacts to depend on</span>`}
					</div>
				</div>

				${renderCriteria("Must Have", art.mustHave, idx, addMustHave,
					(i, val) => { updateArtifactField(i, "mustHave", [...editArtifacts[i].mustHave, val]); },
					(i, itemIdx) => { updateArtifactField(i, "mustHave", editArtifacts[i].mustHave.filter((_, j) => j !== itemIdx)); },
				)}
				${renderCriteria("Should Have", art.shouldHave, idx, addShouldHave,
					(i, val) => { updateArtifactField(i, "shouldHave", [...editArtifacts[i].shouldHave, val]); },
					(i, itemIdx) => { updateArtifactField(i, "shouldHave", editArtifacts[i].shouldHave.filter((_, j) => j !== itemIdx)); },
				)}
				${renderCriteria("Must Not Have", art.mustNotHave, idx, addMustNotHave,
					(i, val) => { updateArtifactField(i, "mustNotHave", [...editArtifacts[i].mustNotHave, val]); },
					(i, itemIdx) => { updateArtifactField(i, "mustNotHave", editArtifacts[i].mustNotHave.filter((_, j) => j !== itemIdx)); },
				)}

				${renderVerificationConfig(art, idx)}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	return html`
		<div class="wf-edit-container">
			<div class="wf-edit-identity">
				<div class="wf-field-row">
					${isNew ? html`
						<div class="wf-field" style="flex:0 0 200px;">
							<label class="wf-field-label">ID</label>
							<input class="wf-input" .value=${editId} placeholder="e.g. bug-fix"
								@input=${(e: Event) => { editId = (e.target as HTMLInputElement).value; renderApp(); }} />
						</div>
					` : html`
						<div class="wf-field" style="flex:0 0 200px;">
							<label class="wf-field-label">ID</label>
							<div class="wf-field-readonly">${editId}</div>
						</div>
					`}
					<div class="wf-field" style="flex:1;min-width:0;">
						<label class="wf-field-label">Name</label>
						<input class="wf-input" .value=${editName} placeholder="Workflow name"
							@input=${(e: Event) => { editName = (e.target as HTMLInputElement).value; renderApp(); }} />
					</div>
				</div>
				<div class="wf-field">
					<label class="wf-field-label">Description</label>
					<textarea class="wf-textarea" .value=${editDescription} placeholder="What this workflow does"
						@input=${(e: Event) => { editDescription = (e.target as HTMLTextAreaElement).value; }}></textarea>
				</div>
			</div>

			<div class="wf-artifacts-header">
				<h2 class="wf-section-title">Artifacts (${editArtifacts.length})</h2>
				${Button({
					variant: "ghost" as any,
					size: "sm",
					onClick: addArtifact,
					children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add Artifact</span>`,
				})}
			</div>

			<div class="wf-artifacts-list">
				${editArtifacts.map((art, idx) => renderArtifactEditor(art, idx))}
				${editArtifacts.length === 0 ? html`
					<div class="wf-empty-artifacts">
						<p>No artifacts defined yet.</p>
						${Button({
							variant: "default",
							size: "sm",
							onClick: addArtifact,
							children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} Add First Artifact</span>`,
						})}
					</div>
				` : nothing}
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderWorkflowPage(): TemplateResult {
	return html`
		<div class="wf-container">
			${renderNavBar()}
			<div class="wf-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
