import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, nothing, type TemplateResult } from "lit";
import { ArrowLeft, ChevronDown, Pencil, Plus, Wrench } from "lucide";
import { fetchTools, fetchToolDetail, updateTool, fetchRoles, gatewayFetch, type ToolInfo, type RoleData } from "./api.js";
import { state, renderApp } from "./state.js";
import { setHashRoute } from "./routing.js";
import { renderTool } from "../ui/tools/index.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TOOL_GROUPS = ["File System", "Shell", "Web", "Browser", "Agent", "Team", "Tasks", "Artifacts", "Other"];

/** Build a mock ToolResultMessage with the correct content array format. */
function mockResult(text: string): any {
	return { type: "tool_result", content: [{ type: "text", text }], tool_use_id: "mock" };
}

/** Sample params and results for renderer preview. */
const TOOL_MOCK_DATA: Record<string, { params: any; result: any }> = {
	bash: {
		params: { command: "npm run check" },
		result: mockResult("No errors found.\n"),
	},
	read: {
		params: { path: "src/app/main.ts", limit: 20 },
		result: mockResult("import { html } from 'lit';\nimport { state } from './state.js';\n// ...(18 more lines)"),
	},
	write: {
		params: { path: "src/app/example.ts", content: "export const hello = 'world';\n" },
		result: mockResult("File written: src/app/example.ts (1 line)"),
	},
	edit: {
		params: { path: "src/app/main.ts", oldText: "const x = 1;", newText: "const x = 2;" },
		result: mockResult("Successfully replaced text in src/app/main.ts."),
	},
	web_search: {
		params: { query: "lit html template best practices" },
		result: mockResult("1. Lit — Best Practices (lit.dev)\n2. Web Components Guide (MDN)\n3. Template Rendering Patterns"),
	},
	web_fetch: {
		params: { url: "https://lit.dev/docs/" },
		result: mockResult("Lit is a simple library for building fast, lightweight web components..."),
	},
	delegate: {
		params: { instructions: "Review the auth module for security issues" },
		result: mockResult("No critical issues found. 2 minor suggestions."),
	},
	ls: {
		params: { path: "src/app" },
		result: mockResult("main.ts\nrender.ts\nrouting.ts\nstate.ts\napi.ts\nsidebar.ts"),
	},
	grep: {
		params: { pattern: "renderTool", path: "src/" },
		result: mockResult("src/ui/tools/index.ts:74: export function renderTool(\nsrc/app/tool-manager-page.ts:10: import { renderTool } from '../ui/tools/index.js';"),
	},
	find: {
		params: { glob: "src/**/*.css" },
		result: mockResult("src/app/app.css\nsrc/app/role-manager.css\nsrc/app/tool-manager.css"),
	},
};

function getMockData(toolName: string): { params: any; result: any } {
	return TOOL_MOCK_DATA[toolName] || {
		params: { example: "value" },
		result: mockResult("OK"),
	};
}

function renderRendererPreview(toolName: string): TemplateResult {
	const mock = getMockData(toolName);
	const inProgress = renderTool(toolName, mock.params, undefined, true);
	const complete = renderTool(toolName, mock.params, mock.result, false);
	return html`
		<div class="tools-renderer-preview">
			<div class="tools-renderer-preview-label">In progress</div>
			<div class="tools-renderer-preview-box">${inProgress.content}</div>
			<div class="tools-renderer-preview-label">Complete</div>
			<div class="tools-renderer-preview-box">${complete.content}</div>
		</div>
	`;
}

// ============================================================================
// STATE
// ============================================================================

type View = "list" | "edit";

let currentView: View = "list";
let tools: ToolInfo[] = [];
let roles: RoleData[] = [];
let selectedTool: ToolInfo | null = null;
let loading = true;
let editDescription = "";
let editGroup = "";
let editDocs = "";
let saving = false;
let collapsedGroups = new Set<string>();

// ============================================================================
// DATA LOADING
// ============================================================================

export async function loadToolPageData(): Promise<void> {
	currentView = "list";
	selectedTool = null;
	loading = true;
	saving = false;
	renderApp();
	const [t, r] = await Promise.all([fetchTools(), fetchRoles()]);
	tools = t;
	roles = r;
	loading = false;
	renderApp();
}

export function clearToolPageState(): void {
	currentView = "list";
	selectedTool = null;
	loading = true;
	saving = false;
}

// ============================================================================
// NAVIGATION
// ============================================================================

function showList(): void {
	currentView = "list";
	selectedTool = null;
	setHashRoute("tools");
}

function showEdit(tool: ToolInfo): void {
	currentView = "edit";
	selectedTool = tool;
	editDescription = tool.description;
	editGroup = tool.group;
	editDocs = tool.docs || "";
	saving = false;
	setHashRoute("tool-edit", tool.name);
}

/** Called by the main router when navigating to #/tools/:name */
export function navigateToToolEdit(toolName: string): void {
	// Try from cached list first
	const tool = tools.find((t) => t.name === toolName);
	if (tool) {
		currentView = "edit";
		selectedTool = tool;
		editDescription = tool.description;
		editGroup = tool.group;
		editDocs = tool.docs || "";
		saving = false;
		renderApp();
		// Also fetch full detail (may have docs)
		fetchToolDetail(toolName).then((detail) => {
			if (detail && selectedTool?.name === toolName) {
				selectedTool = detail;
				// Only update docs from detail if user hasn't changed it
				if (editDocs === (tool.docs || "")) {
					editDocs = detail.docs || "";
				}
				renderApp();
			}
		});
	} else {
		// Not in cache, fetch directly
		fetchToolDetail(toolName).then((detail) => {
			if (detail) {
				currentView = "edit";
				selectedTool = detail;
				editDescription = detail.description;
				editGroup = detail.group;
				editDocs = detail.docs || "";
				saving = false;
			} else {
				currentView = "list";
				selectedTool = null;
			}
			renderApp();
		});
	}
}

async function createToolAssistantSession(): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ toolAssistant: true }),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		const { connectToSession } = await import("./session-manager.js");
		await connectToSession(id, false, { isToolAssistant: true });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create tool assistant", msg);
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

// ============================================================================
// ACTIONS
// ============================================================================

async function handleSave(): Promise<void> {
	if (!selectedTool) return;
	saving = true;
	renderApp();

	const ok = await updateTool(selectedTool.name, {
		description: editDescription,
		group: editGroup,
		docs: editDocs,
	});

	if (ok) {
		// Refresh tools list and update selectedTool
		const [t] = await Promise.all([fetchTools()]);
		tools = t;
		const updated = tools.find((t) => t.name === selectedTool!.name);
		if (updated) {
			// Fetch full detail to get docs back
			const detail = await fetchToolDetail(updated.name);
			if (detail) {
				showEdit(detail);
			} else {
				showEdit(updated);
			}
		} else {
			showList();
		}
		return;
	}
	saving = false;
	renderApp();
}

function toggleGroup(group: string): void {
	if (collapsedGroups.has(group)) {
		collapsedGroups.delete(group);
	} else {
		collapsedGroups.add(group);
	}
	renderApp();
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

function renderNavBar(): TemplateResult {
	if (currentView === "edit" && selectedTool) {
		const hasChanges = selectedTool && (
			editDescription !== selectedTool.description ||
			editGroup !== selectedTool.group ||
			editDocs !== (selectedTool.docs || "")
		);
		return html`
			<div class="tools-nav">
				<div class="tools-nav-left">
					<button class="tools-back" @click=${showList} title="Back to tools">
						${icon(ArrowLeft, "sm")}
					</button>
					<div class="tools-title-group">
						<span class="tools-breadcrumb" @click=${showList}>Tools</span>
						<span class="tools-breadcrumb-sep">/</span>
						<h1 class="tools-title">${selectedTool.name}</h1>
					</div>
				</div>
				<div class="tools-nav-right">
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
		<div class="tools-nav">
			<div class="tools-nav-left">
				<button class="tools-back" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${icon(ArrowLeft, "sm")}
				</button>
				<h1 class="tools-title">Tools</h1>
			</div>
			<div class="tools-nav-right">
				${Button({
					variant: "default",
					size: "sm",
					onClick: createToolAssistantSession,
					children: html`<span class="inline-flex items-center gap-1.5 font-semibold">${icon(Plus, "sm")} New Tool</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: LIST VIEW
// ============================================================================

function renderToolRow(tool: ToolInfo): TemplateResult {
	return html`
		<div class="tool-row" tabindex="0" role="button"
			@click=${() => showEdit(tool)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showEdit(tool); } }}>
			<span class="tool-row-name">${tool.name}</span>
			<span class="tool-row-desc">${tool.description}</span>
			<div class="tool-row-actions">
				<button class="tool-row-action-btn" @click=${(e: Event) => { e.stopPropagation(); showEdit(tool); }} title="Edit">
					${icon(Pencil, "sm")}
				</button>
			</div>
		</div>
	`;
}

function renderListView(): TemplateResult {
	if (loading) {
		return html`
			<div class="tools-loading">
				<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
				</svg>
				<span>Loading tools\u2026</span>
			</div>
		`;
	}

	if (tools.length === 0) {
		return html`
			<div class="tools-empty">
				<p class="tools-empty-title">No tools found</p>
				<p class="tools-empty-desc">Tools are registered by the agent runtime and appear here automatically.</p>
			</div>
		`;
	}

	// Group tools
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const g = tool.group || "Other";
		const list = groups.get(g) || [];
		list.push(tool);
		groups.set(g, list);
	}

	// Sort groups by TOOL_GROUPS order
	const sortedGroups = TOOL_GROUPS.filter((g) => groups.has(g));
	// Add any groups not in TOOL_GROUPS
	for (const g of groups.keys()) {
		if (!sortedGroups.includes(g)) sortedGroups.push(g);
	}

	const chevronSvg = html`<svg class="tool-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

	return html`
		<div class="tools-list">
			${sortedGroups.map((groupName) => {
				const groupTools = groups.get(groupName)!;
				const isCollapsed = collapsedGroups.has(groupName);
				return html`
					<div class="tool-group ${isCollapsed ? "collapsed" : ""}">
						<button class="tool-group-header" @click=${() => toggleGroup(groupName)}>
							${chevronSvg}
							<span class="tool-group-name">${groupName}</span>
							<span class="tool-group-count">${groupTools.length} tool${groupTools.length !== 1 ? "s" : ""}</span>
						</button>
						<div class="tool-group-items">
							${groupTools.map((tool) => renderToolRow(tool))}
						</div>
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: EDIT VIEW
// ============================================================================

function renderEditView(): TemplateResult {
	if (!selectedTool) return html``;

	// Determine role access for this tool
	const roleAccess = roles.map((role) => {
		const allowed = role.allowedTools.includes(selectedTool!.name);
		return { role, allowed };
	});

	return html`
		<div class="tools-edit">
			<!-- Left panel -->
			<div class="tools-edit-main">
				<div class="tools-section">
					<h2 class="tools-section-title">Identity</h2>
					<div class="tools-identity-row">
						<div class="tools-field">
							<label class="tools-field-label">Name</label>
							<div class="tools-field-readonly">${selectedTool.name}</div>
						</div>
						<div class="tools-field" style="flex:1;min-width:0">
							<label class="tools-field-label">Description</label>
							${Input({
								value: editDescription,
								placeholder: "Short description of what this tool does",
								onInput: (e: Event) => { editDescription = (e.target as HTMLInputElement).value; renderApp(); },
							})}
						</div>
					</div>
					<div class="tools-field">
						<label class="tools-field-label">Group</label>
						<select class="tools-select"
							.value=${editGroup}
							@change=${(e: Event) => { editGroup = (e.target as HTMLSelectElement).value; renderApp(); }}>
							${TOOL_GROUPS.map((g) => html`<option value=${g} ?selected=${editGroup === g}>${g}</option>`)}
						</select>
					</div>
				</div>
				<div class="tools-section">
					<h2 class="tools-section-title">Documentation</h2>
					<p class="tools-note">Markdown documentation — usage examples, parameter descriptions, expected output.</p>
					<textarea
						class="tools-docs-editor"
						.value=${editDocs}
						placeholder="Write documentation for this tool..."
						@input=${(e: Event) => { editDocs = (e.target as HTMLTextAreaElement).value; renderApp(); }}
					></textarea>
				</div>
			</div>

			<!-- Right sidebar -->
			<div class="tools-sidebar">
				<!-- Renderer info -->
				<div class="tools-section">
					<h2 class="tools-section-title">Renderer</h2>
					<div class="tools-renderer-card">
						<div class="tools-renderer-status">
							<span class="tools-renderer-dot ${selectedTool.hasRenderer ? "tools-renderer-dot--custom" : "tools-renderer-dot--default"}"></span>
							<span class="tools-renderer-label">${selectedTool.hasRenderer ? "Custom renderer" : "Default renderer"}</span>
						</div>
						${selectedTool.rendererFile
							? html`<span class="tools-renderer-path">${selectedTool.rendererFile}</span>`
							: nothing}
					</div>
					${renderRendererPreview(selectedTool.name)}
				</div>

				<!-- Role access -->
				<div class="tools-section">
					<h2 class="tools-section-title">Role Access</h2>
					<p class="tools-note">Which roles can use this tool.</p>
					${roleAccess.length > 0 ? html`
						<div class="tools-role-list">
							${roleAccess.map(({ role, allowed }) => html`
								<div class="tools-role-row"
									@click=${() => setHashRoute("role-edit", role.name)}>
									<span class="tools-role-name">${role.label}</span>
									<span class="tools-role-badge ${allowed ? "tools-role-badge--allowed" : "tools-role-badge--restricted"}">
										${allowed ? "Allowed" : "Restricted"}
									</span>
								</div>
							`)}
						</div>
					` : html`<p class="tools-note">No roles defined yet.</p>`}
				</div>

				<!-- Tool Assistant shortcut -->
				<div class="tools-section">
					<h2 class="tools-section-title">Actions</h2>
					${Button({
						variant: "ghost" as any,
						size: "sm",
						onClick: createToolAssistantSession,
						children: html`<span class="inline-flex items-center gap-1.5">${icon(Wrench, "sm")} Open Tool Assistant</span>`,
					})}
				</div>
			</div>
		</div>
	`;
}

// ============================================================================
// MAIN RENDER
// ============================================================================

export function renderToolManagerPage(): TemplateResult {
	return html`
		<div class="tools-container">
			${renderNavBar()}
			<div class="tools-body">
				${currentView === "list" ? renderListView() : renderEditView()}
			</div>
		</div>
	`;
}
