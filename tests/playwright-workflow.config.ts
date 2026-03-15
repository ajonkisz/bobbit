import { defineConfig } from "@playwright/test";

/**
 * Workflow status bar test config.
 * Connects to the already-running dev servers (harness mode).
 */
export default defineConfig({
	testDir: ".",
	testMatch: ["workflow-status.spec.ts", "delegate-ui.spec.ts"],
	timeout: 120_000,
	expect: { timeout: 15_000 },
	retries: 0,
	workers: 1,
	use: {
		baseURL: "https://100.123.227.233:5173",
		headless: true,
		viewport: { width: 1280, height: 800 },
		actionTimeout: 15_000,
		ignoreHTTPSErrors: true,
	},
	// No webServer — uses the already-running dev:harness servers
});
