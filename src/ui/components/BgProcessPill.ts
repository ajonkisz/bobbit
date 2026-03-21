import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface BgProcessInfo {
	id: string;
	command: string;
	pid: number;
	status: "running" | "exited";
	exitCode: number | null;
	startTime: number;
}

/**
 * Renders a small pill for each background process. Clicking opens a log popup.
 * Provides a kill button for running processes.
 */
@customElement("bg-process-pill")
export class BgProcessPill extends LitElement {
	@property({ attribute: false }) process!: BgProcessInfo;
	@property() sessionId = "";
	@property({ attribute: false }) onKill?: (id: string) => void;
	@property({ attribute: false }) onDismiss?: (id: string) => void;

	@state() private expanded = false;
	@state() private logs: string[] = [];
	@state() private loadingLogs = false;

	createRenderRoot() {
		return this;
	}

	private _onDocumentClick = (e: MouseEvent) => {
		if (this.expanded && !this.contains(e.target as Node)) {
			this.expanded = false;
		}
	};

	connectedCallback() {
		super.connectedCallback();
		document.addEventListener("click", this._onDocumentClick, true);
	}

	disconnectedCallback() {
		super.disconnectedCallback();
		document.removeEventListener("click", this._onDocumentClick, true);
	}

	private async _toggle(e: MouseEvent) {
		e.stopPropagation();
		this.expanded = !this.expanded;
		if (this.expanded) {
			await this._fetchLogs();
		}
	}

	private async _fetchLogs() {
		if (!this.sessionId || !this.process) return;
		this.loadingLogs = true;
		try {
			const url = localStorage.getItem("gw-url") || window.location.origin;
			const token = localStorage.getItem("gw-token") || "";
			const res = await fetch(`${url}/api/sessions/${this.sessionId}/bg-processes/${this.process.id}/logs?tail=100`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (res.ok) {
				const data = await res.json();
				this.logs = data.log || [];
			}
		} catch { /* ignore */ } finally {
			this.loadingLogs = false;
		}
	}

	private _kill(e: MouseEvent) {
		e.stopPropagation();
		if (this.onKill) this.onKill(this.process.id);
	}

	private _dismiss(e: MouseEvent) {
		e.stopPropagation();
		if (this.onDismiss) this.onDismiss(this.process.id);
	}

	private _shortCommand(): string {
		const cmd = this.process.command;
		// Show first 30 chars
		return cmd.length > 30 ? cmd.slice(0, 27) + "..." : cmd;
	}

	render() {
		if (!this.process) return nothing;
		const p = this.process;
		const isRunning = p.status === "running";
		const statusDot = isRunning
			? html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-400 shrink-0 animate-pulse"></span>`
			: p.exitCode === 0
				? html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground shrink-0"></span>`
				: html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-400 shrink-0"></span>`;

		return html`
			<button
				class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight"
				style="max-width:200px"
				@click=${this._toggle}
				title="${p.command}"
			>
				${statusDot}
				<span class="truncate font-mono">${this._shortCommand()}</span>
				${!isRunning && p.exitCode !== null
					? html`<span class="${p.exitCode === 0 ? "text-muted-foreground" : "text-red-400"} shrink-0">${p.exitCode}</span>`
					: nothing}
				${!isRunning ? html`<span
					class="ml-0.5 text-muted-foreground hover:text-foreground transition-colors shrink-0"
					@click=${this._dismiss}
					title="Dismiss"
				>&times;</span>` : nothing}
			</button>

			${this.expanded
				? html`
					<div
						class="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 text-xs"
						style="max-width:min(500px, calc(100vw - 1rem)); min-width: 300px;"
						id="bg-process-dropdown"
					>
						<div class="flex items-center justify-between mb-2">
							<div class="flex items-center gap-1.5 text-foreground font-medium text-sm min-w-0">
								${statusDot}
								<span class="truncate font-mono">${p.id}</span>
								<span class="text-[10px] text-muted-foreground font-normal">pid ${p.pid}</span>
							</div>
							${isRunning
								? html`<button
									class="px-2 py-0.5 rounded text-[11px] bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
									@click=${this._kill}
								>Kill</button>`
								: nothing}
						</div>

						<div class="text-muted-foreground mb-2 font-mono break-all">${p.command}</div>

						<div class="border-t border-border pt-2 mt-1">
							<div class="flex items-center justify-between mb-1">
								<span class="text-muted-foreground font-medium">Output</span>
								<button
									class="text-[10px] text-muted-foreground hover:text-foreground"
									@click=${(e: MouseEvent) => { e.stopPropagation(); this._fetchLogs(); }}
								>Refresh</button>
							</div>
							${this.loadingLogs
								? html`<div class="text-muted-foreground animate-pulse">Loading...</div>`
								: html`
									<div class="max-h-[300px] overflow-y-auto bg-background rounded p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
										${this.logs.length > 0
											? this.logs.map((line) => html`<div>${line}</div>`)
											: html`<span class="text-muted-foreground">(no output yet)</span>`}
									</div>
								`}
						</div>
					</div>
				`
				: nothing}
		`;
	}

	override updated(changed: Map<string, unknown>) {
		super.updated(changed);
		if (changed.has("expanded") && this.expanded) {
			this._positionDropdown();
		}
	}

	private _positionDropdown() {
		const btn = this.querySelector("button");
		const dropdown = this.querySelector("#bg-process-dropdown") as HTMLElement;
		if (!btn || !dropdown) return;
		const rect = btn.getBoundingClientRect();
		// Position above the button, aligned to its left edge
		dropdown.style.left = `${rect.left}px`;
		dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
	}
}
