import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('git-status-widget')
export class GitStatusWidget extends LitElement {
    @property() branch = '';
    @property() summary = '';
    @property({ type: Boolean }) clean = true;
    @property({ type: Number }) ahead = 0;
    @property({ type: Number }) behind = 0;
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
            case 'M':
                return 'text-amber-400';
            case 'A':
                return 'text-green-400';
            case 'D':
                return 'text-red-400';
            case '?':
                return 'text-muted-foreground';
            case 'R':
                return 'text-blue-400';
            case 'U':
                return 'text-red-500';
            default:
                return 'text-muted-foreground';
        }
    }

    private _statusLabel(status: string): string {
        switch (status) {
            case 'M':
                return 'modified';
            case 'A':
                return 'added';
            case 'D':
                return 'deleted';
            case '?':
                return 'untracked';
            case 'R':
                return 'renamed';
            case 'U':
                return 'unmerged';
            default:
                return status;
        }
    }

    private _renderPushStatus() {
        if (this.ahead > 0 && this.behind > 0) {
            return html`<span class="text-amber-400">${this.ahead} ahead, ${this.behind} behind</span>`;
        }
        if (this.ahead > 0) {
            return html`<span class="text-amber-400">${this.ahead} commit${this.ahead > 1 ? 's' : ''} ahead</span>`;
        }
        if (this.behind > 0) {
            return html`<span class="text-amber-400">${this.behind} commit${this.behind > 1 ? 's' : ''} behind</span>`;
        }
        return html`<span class="text-green-400">up to date with remote</span>`;
    }

    render() {
        if (!this.branch && !this.loading) return nothing;

        const summaryColor = this.clean ? 'text-green-400' : 'text-amber-400';

        return html`
            <div class="relative inline-block">
                <button
                    class="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight"
                    @click=${this._toggle}
                >
                    ${this.loading
                        ? html`<span class="animate-pulse">⎇</span>`
                        : html`<span>⎇</span>`}
                    <span class="max-w-[120px] sm:max-w-[280px] truncate">${this.branch}</span>
                    ${this.summary
                        ? html`<span class="${summaryColor} font-medium">${this.summary}</span>`
                        : nothing}
                    ${this.unpushed ? html`<span class="text-amber-400">↑</span>` : nothing}
                </button>

                ${this.expanded
                    ? html`
                          <div
                              class="absolute right-0 bottom-full mb-1 z-50 min-w-[260px] max-w-[360px] bg-card border border-border rounded-lg shadow-lg p-3 text-xs"
                          >
                              <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                                  <span>⎇</span>
                                  <span>${this.branch}</span>
                              </div>

                              <div class="mb-2 text-muted-foreground">
                                  Push status: ${this._renderPushStatus()}
                              </div>

                              ${this.statusFiles.length > 0
                                  ? html`
                                        <div class="border-t border-border pt-2 mt-2">
                                            <div class="text-muted-foreground mb-1 font-medium">Changes</div>
                                            <div class="flex flex-col gap-0.5 max-h-[200px] overflow-y-auto">
                                                ${this.statusFiles.map(
                                                    (f) => html`
                                                        <div class="flex items-center gap-2 py-0.5">
                                                            <span
                                                                class="${this._statusColor(f.status)} font-mono w-[70px] shrink-0 text-right"
                                                                title=${this._statusLabel(f.status)}
                                                            >
                                                                ${this._statusLabel(f.status)}
                                                            </span>
                                                            <span
                                                                class="text-foreground truncate"
                                                                title=${f.file}
                                                            >
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
            </div>
        `;
    }
}
