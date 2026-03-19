import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

/** Persisted goal assistant draft state for a session. */
export interface GoalDraft {
	sessionId: string;
	activeGoalProposal?: { title: string; spec: string; cwd?: string };
	previewTitle?: string;
	previewSpec?: string;
	previewCwd?: string;
	previewTitleEdited?: boolean;
	previewSpecEdited?: boolean;
	previewCwdEdited?: boolean;
	hasReceivedProposal?: boolean;
	goalAssistantTab?: "chat" | "preview";
	previewTeamMode?: boolean;
	previewWorktree?: boolean;
}

export class GoalDraftStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "goalDrafts",
		};
	}

	async getDraft(sessionId: string): Promise<GoalDraft | null> {
		return this.getBackend().get<GoalDraft>("goalDrafts", sessionId);
	}

	async saveDraft(draft: GoalDraft): Promise<void> {
		await this.getBackend().set("goalDrafts", draft.sessionId, draft);
	}

	async deleteDraft(sessionId: string): Promise<void> {
		await this.getBackend().delete("goalDrafts", sessionId);
	}

	async listDraftSessionIds(): Promise<string[]> {
		return this.getBackend().keys("goalDrafts");
	}
}
