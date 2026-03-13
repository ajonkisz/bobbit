import path from "node:path";
import { defineConfig } from "@playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "..");

/**
 * E2E config that starts the gateway + vite dev server for real integration tests.
 *
 * The gateway must be built first: npm run build:server
 *
 * Uses localhost to avoid NordVPN dependency in CI / local dev.
 */
export default defineConfig({
	testDir: ".",
	testMatch: "session-rename.spec.ts",
	timeout: 180_000,
	expect: { timeout: 30_000 },
	retries: 0,
	workers: 1, // serial — tests share the gateway
	use: {
		baseURL: "http://localhost:5174",
		// Headless by default; use --headed to watch
		headless: true,
		viewport: { width: 1280, height: 800 },
		actionTimeout: 15_000,
	},
	webServer: [
		{
			// Gateway on port 3001, bound to localhost, no embedded UI
			command: "node dist/server/cli.js --host localhost --port 3001 --cwd . --no-ui",
			cwd: projectRoot,
			port: 3001,
			reuseExistingServer: true,
			timeout: 30_000,
			env: {
				...process.env,
				VITE_HOST: "localhost",
			},
		},
		{
			// Vite dev server on port 5174, proxying to the gateway
			command: "npx vite --port 5174 --host localhost",
			cwd: projectRoot,
			port: 5174,
			reuseExistingServer: true,
			timeout: 15_000,
			env: {
				...process.env,
				VITE_HOST: "localhost",
				GATEWAY_URL: "http://localhost:3001",
			},
		},
	],
});
