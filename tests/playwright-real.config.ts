import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	timeout: 15_000,
	use: {
		baseURL: "http://localhost:5174",
	},
	webServer: {
		command: "npx vite --port 5174",
		port: 5174,
		reuseExistingServer: true,
		timeout: 15_000,
	},
});
