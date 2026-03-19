import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export interface RoleDraft {
	sessionId: string;
	activeRoleProposal?: { name: string; label: string; prompt: string; tools: string; accessory: string };
	previewName?: string;
	previewLabel?: string;
	previewPrompt?: string;
	previewTools?: string;
	previewAccessory?: string;
	previewNameEdited?: boolean;
	previewLabelEdited?: boolean;
	previewPromptEdited?: boolean;
	previewToolsEdited?: boolean;
	previewAccessoryEdited?: boolean;
	hasReceivedRoleProposal?: boolean;
	roleAssistantTab?: "chat" | "preview";
}

export class RoleDraftStore extends Store {
	getConfig(): StoreConfig {
		return { name: "roleDrafts" };
	}
	async getDraft(sessionId: string): Promise<RoleDraft | null> {
		return this.getBackend().get<RoleDraft>("roleDrafts", sessionId);
	}
	async saveDraft(draft: RoleDraft): Promise<void> {
		await this.getBackend().set("roleDrafts", draft.sessionId, draft);
	}
	async deleteDraft(sessionId: string): Promise<void> {
		await this.getBackend().delete("roleDrafts", sessionId);
	}
	async listDraftSessionIds(): Promise<string[]> {
		return this.getBackend().keys("roleDrafts");
	}
}
