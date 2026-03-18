import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 30_000,
	webServer: {
		command: 'node dist/server/cli.js --host 127.0.0.1 --port 3099 --no-tls --no-ui',
		url: 'http://127.0.0.1:3099/api/sessions',
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: 'ignore',
		stderr: 'pipe',
	},
	use: { baseURL: 'http://127.0.0.1:3099' },
});
