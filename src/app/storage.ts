import {
	AppStorage,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "../ui/index.js";
import { CommandHistoryStore } from "../ui/storage/stores/command-history-store.js";
import { GoalDraftStore } from "../ui/storage/stores/goal-draft-store.js";
import { RoleDraftStore } from "../ui/storage/stores/role-draft-store.js";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const goalDrafts = new GoalDraftStore();
const roleDrafts = new RoleDraftStore();
const commandHistory = new CommandHistoryStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 4,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		goalDrafts.getConfig(),
		roleDrafts.getConfig(),
		commandHistory.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);
goalDrafts.setBackend(backend);
roleDrafts.setBackend(backend);
commandHistory.setBackend(backend);

export const storage = new AppStorage(settings, providerKeys, sessions, customProviders, goalDrafts, roleDrafts, commandHistory, backend);
setAppStorage(storage);
