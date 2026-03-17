import {
	AppStorage,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "../ui/index.js";
import { GoalDraftStore } from "../ui/storage/stores/goal-draft-store.js";

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();
const goalDrafts = new GoalDraftStore();

const backend = new IndexedDBStorageBackend({
	dbName: "pi-gateway-ui",
	version: 2,
	stores: [
		settings.getConfig(),
		SessionsStore.getMetadataConfig(),
		providerKeys.getConfig(),
		customProviders.getConfig(),
		sessions.getConfig(),
		goalDrafts.getConfig(),
	],
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);
goalDrafts.setBackend(backend);

export const storage = new AppStorage(settings, providerKeys, sessions, customProviders, goalDrafts, backend);
setAppStorage(storage);
