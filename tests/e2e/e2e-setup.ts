/**
 * Shared E2E test helpers.
 *
 * The E2E test server runs with BOBBIT_PI_DIR pointing to an isolated temp
 * directory so it doesn't pollute the real dev-server state under ~/.pi.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The isolated PI directory used by the E2E test server — must match playwright-e2e.config.ts */
export const E2E_PI_DIR = join(__dirname, "..", "..", ".e2e-pi");

/** Read the auth token that the test server auto-created on startup. */
export function readE2EToken(): string {
	return readFileSync(join(E2E_PI_DIR, "gateway-token"), "utf-8").trim();
}
