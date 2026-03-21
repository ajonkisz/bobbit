import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Isolated state directory so UI E2E tests don't pollute ~/.pi
const E2E_UI_PI_DIR = path.join(__dirname, "..", ".e2e-ui-pi");

/**
 * E2E config for tests that need the full UI (not just the API).
 * Serves the embedded UI from dist/ui/ (requires `npm run build` first).
 * Uses port 3098 to avoid conflicts with dev (3001) and API-only E2E (3099).
 */
export default defineConfig({
	testDir: "./e2e",
	testMatch: "mobile-header-race-e2e.spec.ts",
	timeout: 30_000,
	webServer: {
		command: `node ${path.join(ROOT, "dist/server/cli.js")} --host 127.0.0.1 --port 3098 --no-tls`,
		url: "http://127.0.0.1:3098/api/sessions",
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: "ignore",
		stderr: "pipe",
		env: {
			...process.env,
			BOBBIT_PI_DIR: E2E_UI_PI_DIR,
		},
	},
	use: { baseURL: "http://127.0.0.1:3098" },
});
