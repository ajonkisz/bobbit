import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";

export class StreamingMessageContainer extends LitElement {
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Boolean }) hasMessages = false;
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;
	@property({ attribute: false }) onCostClick?: () => void;

	@state() private _message: AgentMessage | null = null;
	@state() private _blobState: 'hidden' | 'active' | 'entering' | 'exiting' | 'idle' | 'compacting' | 'compact-pop' = 'hidden';
	private _exitVariant: 'exit' | 'exit-roll' = 'exit';
	private _entryVariant: 'enter' | 'enter-roll' = 'enter';
	private _pendingMessage: AgentMessage | null = null;
	private _updateScheduled = false;
	private _immediateUpdate = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	override updated(changed: Map<string, unknown>) {
		if (changed.has("isStreaming")) {
			if (this.isStreaming && this._blobState === 'idle') {
				// Coming from idle — play entry animation
				this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
				this._blobState = 'entering';
				setTimeout(() => {
					this._blobState = 'active';
				}, this._entryVariant === 'enter-roll' ? 900 : 700);
			} else if (this.isStreaming) {
				this._blobState = 'active';
			} else if (this._blobState === 'active') {
				// Streaming stopped — randomly pick exit variant, then go idle
				this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
				this._blobState = 'exiting';
				setTimeout(() => {
					this._blobState = 'idle';
				}, this._exitVariant === 'exit-roll' ? 900 : 700);
			}
		}
		// If there are messages but blob is still hidden, show as idle
		if (changed.has("hasMessages") && this._blobState === 'hidden' && this.hasMessages) {
			this._blobState = 'idle';
		}
	}

	private get _blobVisible() {
		return this._blobState !== 'hidden';
	}

	private get _blobClass() {
		if (this._blobState === 'entering') return `bobbit-blob bobbit-blob--${this._entryVariant}`;
		if (this._blobState === 'exiting') return `bobbit-blob bobbit-blob--${this._exitVariant}`;
		if (this._blobState === 'idle') return 'bobbit-blob bobbit-blob--idle';
		if (this._blobState === 'compacting') return 'bobbit-blob bobbit-blob--compacting';
		if (this._blobState === 'compact-pop') return 'bobbit-blob bobbit-blob--compact-pop';
		return 'bobbit-blob';
	}

	/** Start the compaction squash animation */
	public startCompacting() {
		// If idle, enter first then compact; otherwise go straight to compacting
		if (this._blobState === 'idle') {
			this._entryVariant = Math.random() < 0.5 ? 'enter' : 'enter-roll';
			this._blobState = 'entering';
			setTimeout(() => {
				this._blobState = 'compacting';
			}, this._entryVariant === 'enter-roll' ? 900 : 700);
		} else {
			this._blobState = 'compacting';
		}
	}

	/** End the compaction animation — pop back to size then go idle */
	public endCompacting() {
		this._blobState = 'compact-pop';
		setTimeout(() => {
			this._exitVariant = Math.random() < 0.5 ? 'exit' : 'exit-roll';
			this._blobState = 'exiting';
			setTimeout(() => {
				this._blobState = 'idle';
			}, this._exitVariant === 'exit-roll' ? 900 : 700);
		}, 600); // pop duration
	}

	// Public method to update the message with batching for performance
	public setMessage(message: AgentMessage | null, immediate = false) {
		// Store the latest message
		this._pendingMessage = message;

		// If this is an immediate update (like clearing), apply it right away
		if (immediate || message === null) {
			this._immediateUpdate = true;
			this._message = message;
			this.requestUpdate();
			// Cancel any pending updates since we're clearing
			this._pendingMessage = null;
			this._updateScheduled = false;
			return;
		}

		// Otherwise batch updates for performance during streaming
		if (!this._updateScheduled) {
			this._updateScheduled = true;

			requestAnimationFrame(async () => {
				// Only apply the update if we haven't been cleared
				if (!this._immediateUpdate && this._pendingMessage !== null) {
					// Deep clone the message to ensure Lit detects changes in nested properties
					// (like toolCall.arguments being mutated during streaming)
					this._message = JSON.parse(JSON.stringify(this._pendingMessage));
					this.requestUpdate();
				}
				// Reset for next batch
				this._pendingMessage = null;
				this._updateScheduled = false;
				this._immediateUpdate = false;
			});
		}
	}

	override render() {
		// Show loading indicator if loading but no message yet
		if (!this._message) {
			if (this._blobVisible)
				return html`<div class="flex flex-col gap-3 mb-3">
					<div class="${this._blobClass}">
						<div class="bobbit-blob__sprite"></div>
						<div class="bobbit-blob__shadow"></div>
					</div>
				</div>`;
			return html``; // Empty until a message is set
		}
		const msg = this._message;

		if (msg.role === "toolResult") {
			// Skip standalone tool result in streaming; the stable list will render paired tool-message
			return html``;
		} else if (msg.role === "user" || msg.role === "user-with-attachments") {
			// Skip standalone tool result in streaming; the stable list will render it immediiately
			return html``;
		} else if (msg.role === "assistant") {
			// Assistant message - render inline tool messages during streaming
			return html`
				<div class="flex flex-col gap-3 mb-3">
					<assistant-message
						.message=${msg}
						.tools=${this.tools}
						.isStreaming=${this.isStreaming}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${this.toolResultsById}
						.hideToolCalls=${false}
						.onCostClick=${this.onCostClick}
					></assistant-message>
					${this._blobVisible ? html`<div class="${this._blobClass}">
						<div class="bobbit-blob__sprite"></div>
						<div class="bobbit-blob__shadow"></div>
					</div>` : ""}
				</div>
			`;
		}
	}
}

// Register custom element
if (!customElements.get("streaming-message-container")) {
	customElements.define("streaming-message-container", StreamingMessageContainer);
}
