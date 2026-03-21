import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export interface PersonalityDraft {
	sessionId: string;
	activePersonalityProposal?: { name: string; label: string; description: string; prompt_fragment: string };
	previewName?: string;
	previewLabel?: string;
	previewDescription?: string;
	previewPromptFragment?: string;
	previewNameEdited?: boolean;
	previewLabelEdited?: boolean;
	previewDescriptionEdited?: boolean;
	previewPromptFragmentEdited?: boolean;
	hasReceivedPersonalityProposal?: boolean;
	personalityAssistantTab?: "chat" | "preview";
}

export class PersonalityDraftStore extends Store {
	getConfig(): StoreConfig {
		return { name: "personalityDrafts" };
	}
	async getDraft(sessionId: string): Promise<PersonalityDraft | null> {
		return this.getBackend().get<PersonalityDraft>("personalityDrafts", sessionId);
	}
	async saveDraft(draft: PersonalityDraft): Promise<void> {
		await this.getBackend().set("personalityDrafts", draft.sessionId, draft);
	}
	async deleteDraft(sessionId: string): Promise<void> {
		await this.getBackend().delete("personalityDrafts", sessionId);
	}
	async listDraftSessionIds(): Promise<string[]> {
		return this.getBackend().keys("personalityDrafts");
	}
}
