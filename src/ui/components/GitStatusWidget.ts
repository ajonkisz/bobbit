import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('git-status-widget')
export class GitStatusWidget extends LitElement {
    @property() branch = '';
    @property() primaryBranch = 'master';
    @property({ type: Boolean }) isOnPrimary = true;
    @property() summary = '';
    @property({ type: Boolean }) clean = true;
    @property({ type: Boolean }) hasUpstream = false;
    @property({ type: Number }) ahead = 0;
    @property({ type: Number }) behind = 0;
    @property({ type: Number }) aheadOfPrimary = 0;
    @property({ type: Number }) behindPrimary = 0;
    @property({ type: Boolean }) mergedIntoPrimary = false;
    @property({ type: Boolean }) unpushed = false;
    @property({ type: Array }) statusFiles: Array<{ file: string; status: string }> = [];
    @property({ type: Boolean }) loading = false;

    @state() private expanded = false;

    private _onDocumentClick = (e: MouseEvent) => {
        if (this.expanded && !this.contains(e.target as Node)) {
            this.expanded = false;
        }
    };

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener('click', this._onDocumentClick, true);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('click', this._onDocumentClick, true);
    }

    private _toggle(e: MouseEvent) {
        e.stopPropagation();
        this.expanded = !this.expanded;
    }

    private _statusColor(status: string): string {
        switch (status) {
            case 'M': return 'text-amber-400';
            case 'A': return 'text-green-400';
            case 'D': return 'text-red-400';
            case '?': return 'text-muted-foreground';
            case 'R': return 'text-blue-400';
            case 'U': return 'text-red-500';
            default: return 'text-muted-foreground';
        }
    }

    private _statusLabel(status: string): string {
        switch (status) {
            case 'M': return 'modified';
            case 'A': return 'added';
            case 'D': return 'deleted';
            case '?': return 'untracked';
            case 'R': return 'renamed';
            case 'U': return 'unmerged';
            default: return status;
        }
    }

    /** Terse pill indicator: ↑ unpushed, ↗ not merged to primary, ✓ all good */
    private _pillIndicator() {
        if (!this.isOnPrimary && this.mergedIntoPrimary && !this.unpushed) {
            // All work is on primary — nothing to flag
            return nothing;
        }
        if (this.unpushed) {
            return html`<span class="text-amber-400 shrink-0">↑</span>`;
        }
        if (!this.isOnPrimary && !this.mergedIntoPrimary) {
            return html`<span class="text-blue-400 shrink-0">↗</span>`;
        }
        return nothing;
    }

    private _renderRemoteStatus() {
        if (this.isOnPrimary) {
            // On primary branch — show ahead/behind vs remote
            if (this.ahead > 0 && this.behind > 0) {
                return html`<span class="text-amber-400">${this.ahead} ahead, ${this.behind} behind remote</span>`;
            }
            if (this.ahead > 0) {
                return html`<span class="text-amber-400">${this.ahead} unpushed commit${this.ahead > 1 ? 's' : ''}</span>`;
            }
            if (this.behind > 0) {
                return html`<span class="text-amber-400">${this.behind} commit${this.behind > 1 ? 's' : ''} behind remote</span>`;
            }
            return html`<span class="text-green-400">up to date with remote</span>`;
        }

        // On a feature branch
        if (this.mergedIntoPrimary) {
            return html`<span class="text-green-400">merged into ${this.primaryBranch}</span>`;
        }
        if (!this.hasUpstream) {
            return html`<span class="text-amber-400">local only — not pushed</span>`;
        }
        if (this.ahead > 0) {
            return html`<span class="text-amber-400">${this.ahead} unpushed commit${this.ahead > 1 ? 's' : ''}</span>`;
        }
        return html`<span class="text-green-400">pushed to remote branch</span>`;
    }

    private _renderPrimaryStatus() {
        if (this.isOnPrimary) return nothing;

        const primary = this.primaryBranch;
        if (this.mergedIntoPrimary && this.behindPrimary === 0) {
            return nothing; // Already shown as "merged into master" in remote status
        }
        if (this.mergedIntoPrimary && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                ${primary} is <span class="text-blue-400">${this.behindPrimary} commit${this.behindPrimary > 1 ? 's' : ''} ahead</span> of this branch
            </div>`;
        }
        if (this.aheadOfPrimary > 0 && this.behindPrimary > 0) {
            return html`<div class="text-muted-foreground">
                vs ${primary}: <span class="text-blue-400">${this.aheadOfPrimary} ahead</span>, <span class="text-amber-400">${this.behindPrimary} behind</span>
            </div>`;
        }
        if (this.aheadOfPrimary > 0) {
            return html`<div class="text-muted-foreground">
                vs ${primary}: <span class="text-blue-400">${this.aheadOfPrimary} commit${this.aheadOfPrimary > 1 ? 's' : ''} not yet merged</span>
            </div>`;
        }
        return nothing;
    }

    render() {
        if (!this.branch && !this.loading) return nothing;

        const summaryColor = this.clean ? 'text-green-400' : 'text-amber-400';

        return html`
            <button
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight"
                style="max-width:100%"
                @click=${this._toggle}
            >
                ${this.loading
                    ? html`<span class="animate-pulse shrink-0">⎇</span>`
                    : html`<span class="shrink-0">⎇</span>`}
                <span class="truncate">${this.branch}</span>
                ${this.summary
                    ? html`<span class="${summaryColor} font-medium shrink-0">${this.summary}</span>`
                    : nothing}
                ${this._pillIndicator()}
            </button>

            ${this.expanded
                ? html`
                      <div
                          class="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 text-xs"
                          style="max-width:min(360px, calc(100vw - 1rem))"
                          id="git-status-dropdown"
                      >
                          <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                              <span>⎇</span>
                              <span class="break-all">${this.branch}</span>
                              ${!this.isOnPrimary
                                  ? html`<span class="text-[10px] text-muted-foreground font-normal">(feature)</span>`
                                  : nothing}
                          </div>

                          <div class="flex flex-col gap-1 mb-2">
                              <div class="text-muted-foreground">
                                  Remote: ${this._renderRemoteStatus()}
                              </div>
                              ${this._renderPrimaryStatus()}
                          </div>

                          ${this.statusFiles.length > 0
                              ? html`
                                    <div class="border-t border-border pt-2 mt-2">
                                        <div class="text-muted-foreground mb-1 font-medium">Changes</div>
                                        <div class="flex flex-col gap-0.5 max-h-[200px] overflow-y-auto">
                                            ${this.statusFiles.map(
                                                (f) => html`
                                                    <div class="flex items-center gap-2 py-0.5 min-w-0">
                                                        <span
                                                            class="${this._statusColor(f.status)} font-mono w-[70px] shrink-0 text-right"
                                                            title=${this._statusLabel(f.status)}
                                                        >
                                                            ${this._statusLabel(f.status)}
                                                        </span>
                                                        <span class="text-foreground truncate" title=${f.file}>
                                                            ${f.file}
                                                        </span>
                                                    </div>
                                                `
                                            )}
                                        </div>
                                    </div>
                                `
                              : html`
                                    <div class="text-green-400 border-t border-border pt-2 mt-2">
                                        Working tree clean
                                    </div>
                                `}
                      </div>
                  `
                : nothing}
        `;
    }

    override updated(changed: Map<string, unknown>) {
        super.updated(changed);
        if (changed.has('expanded') && this.expanded) {
            this._positionDropdown();
        }
    }

    private _positionDropdown() {
        const btn = this.querySelector('button');
        const dropdown = this.querySelector('#git-status-dropdown') as HTMLElement;
        if (!btn || !dropdown) return;
        const rect = btn.getBoundingClientRect();
        dropdown.style.right = `${window.innerWidth - rect.right}px`;
        dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    }
}
