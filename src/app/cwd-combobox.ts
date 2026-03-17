import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { ChevronDown, GitBranch } from "lucide";
import { state } from "./state.js";

/** Collect unique working directories from sessions and goals, most recent first. */
export function getRecentCwds(): Array<{ path: string; source: string }> {
	const seen = new Set<string>();
	const results: Array<{ path: string; source: string }> = [];

	// Sessions (sorted by lastActivity descending)
	const sessions = [...state.gatewaySessions]
		.filter((s) => s.cwd && !s.goalAssistant && !s.delegateOf)
		.sort((a, b) => b.lastActivity - a.lastActivity);
	for (const s of sessions) {
		const p = s.cwd;
		if (!seen.has(p)) {
			seen.add(p);
			results.push({ path: p, source: "session" });
		}
	}

	// Goals
	const goals = [...state.goals].sort((a, b) => b.updatedAt - a.updatedAt);
	for (const g of goals) {
		const p = g.repoPath || g.cwd;
		if (p && !seen.has(p)) {
			seen.add(p);
			results.push({ path: p, source: "goal" });
		}
	}
	return results;
}

export interface CwdComboboxProps {
	value: string;
	placeholder?: string;
	onInput: (value: string) => void;
	onSelect: (value: string) => void;
	dropdownOpen: boolean;
	onToggle: (open: boolean) => void;
}

/**
 * Render a cwd combobox: text input with a dropdown of recent working directories.
 */
export function cwdCombobox(opts: CwdComboboxProps) {
	const allCwds = getRecentCwds();
	const query = opts.value.toLowerCase();
	const filtered = query
		? allCwds.filter((c) => c.path.toLowerCase().includes(query))
		: allCwds;

	const selectItem = (path: string) => {
		opts.onSelect(path);
		opts.onToggle(false);
	};

	// Close dropdown on blur (delay lets click fire first)
	const handleBlur = () => {
		setTimeout(() => opts.onToggle(false), 200);
	};

	return html`
		<div class="cwd-combobox">
			<div class="relative flex items-center">
				<input
					type="text"
					class="flex w-full min-w-0 rounded-md border border-input bg-transparent text-foreground shadow-xs h-9 px-3 py-1 text-sm pr-8 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none dark:bg-input/30"
					.value=${opts.value}
					placeholder=${opts.placeholder || "(server default)"}
					@input=${(e: Event) => {
						opts.onInput((e.target as HTMLInputElement).value);
						if (!opts.dropdownOpen) opts.onToggle(true);
					}}
					@focus=${() => { if (allCwds.length > 0) opts.onToggle(true); }}
					@blur=${handleBlur}
				/>
				${allCwds.length > 0 ? html`
					<button
						type="button"
						class="absolute right-0 top-0 bottom-0 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
						@mousedown=${(e: Event) => { e.preventDefault(); opts.onToggle(!opts.dropdownOpen); }}
						tabindex="-1"
					>
						${icon(ChevronDown, "xs")}
					</button>
				` : ""}
			</div>
			${opts.dropdownOpen && allCwds.length > 0 ? html`
				<div class="cwd-combobox-dropdown">
					${filtered.length > 0 ? filtered.map((c) => html`
						<div class="cwd-combobox-item" @mousedown=${(e: Event) => { e.preventDefault(); selectItem(c.path); }}>
							<span class="cwd-path" title=${c.path}>${c.path}</span>
							<span class="cwd-source">${c.source}</span>
						</div>
					`) : html`
						<div class="cwd-combobox-empty">No matching directories</div>
					`}
				</div>
			` : ""}
		</div>
	`;
}

/**
 * Render a worktree toggle: a toggle switch with a git-branch icon and label.
 */
export function worktreeToggle(opts: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	id?: string;
}) {
	return html`
		<label class="flex items-center gap-2 cursor-pointer">
			<input type="checkbox"
				id=${opts.id || ""}
				.checked=${opts.checked}
				@change=${(e: Event) => opts.onChange((e.target as HTMLInputElement).checked)}
				class="toggle-switch" />
			<span class="text-xs text-muted-foreground inline-flex items-center gap-1">${icon(GitBranch, "xs")} Create worktree</span>
		</label>
	`;
}
