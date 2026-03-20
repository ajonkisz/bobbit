import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated state directory so E2E tests don't pollute ~/.pi
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E_PI_DIR = path.join(__dirname, '.e2e-pi');

export default defineConfig({
	testDir: './tests/e2e',
	testIgnore: ['**/mobile-header-race-e2e*'],
	timeout: 30_000,
	webServer: {
		command: 'node dist/server/cli.js --host 127.0.0.1 --port 3099 --no-tls --no-ui',
		url: 'http://127.0.0.1:3099/api/sessions',
		reuseExistingServer: false,
		timeout: 30_000,
		stdout: 'ignore',
		stderr: 'pipe',
		env: {
			...process.env,
			BOBBIT_PI_DIR: E2E_PI_DIR,
		},
	},
	use: { baseURL: 'http://127.0.0.1:3099' },
});
