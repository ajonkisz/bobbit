import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

/** Persisted artifact-spec assistant draft state for a session. */
export interface SpecDraft {
	sessionId: string;
	activeArtifactSpecProposal?: { id: string; name: string; description: string; kind: string; format: string; mustHave: string; shouldHave: string; mustNotHave: string; requires: string; suggestedRole: string };
	specPreviewId?: string;
	specPreviewName?: string;
	specPreviewDescription?: string;
	specPreviewKind?: string;
	specPreviewFormat?: string;
	specPreviewMustHave?: string;
	specPreviewShouldHave?: string;
	specPreviewMustNotHave?: string;
	specPreviewRequires?: string;
	specPreviewSuggestedRole?: string;
	specPreviewIdEdited?: boolean;
	specPreviewNameEdited?: boolean;
	specPreviewDescriptionEdited?: boolean;
	specPreviewKindEdited?: boolean;
	specPreviewFormatEdited?: boolean;
	specPreviewMustHaveEdited?: boolean;
	specPreviewShouldHaveEdited?: boolean;
	specPreviewMustNotHaveEdited?: boolean;
	specPreviewRequiresEdited?: boolean;
	specPreviewSuggestedRoleEdited?: boolean;
	hasReceivedSpecProposal?: boolean;
	assistantTab?: "chat" | "preview";
}

export class SpecDraftStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "specDrafts",
		};
	}

	async getDraft(sessionId: string): Promise<SpecDraft | null> {
		return this.getBackend().get<SpecDraft>("specDrafts", sessionId);
	}

	async saveDraft(draft: SpecDraft): Promise<void> {
		await this.getBackend().set("specDrafts", draft.sessionId, draft);
	}

	async deleteDraft(sessionId: string): Promise<void> {
		await this.getBackend().delete("specDrafts", sessionId);
	}
}
