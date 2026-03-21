/**
 * Shared E2E test helpers.
 *
 * The E2E test server runs with BOBBIT_PI_DIR pointing to an isolated temp
 * directory so it doesn't pollute the real dev-server state under ~/.pi.
 *
 * Port and PI dir are set dynamically by playwright-e2e.config.ts via
 * process.env so parallel test runs on the same machine never collide.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Port the isolated E2E gateway is listening on (set by config via env). */
export const E2E_PORT = process.env.E2E_PORT || "3099";

/** HTTP base URL for the isolated E2E gateway. */
export const BASE = `http://127.0.0.1:${E2E_PORT}`;

/** WebSocket base URL for the isolated E2E gateway. */
export const WS_BASE = `ws://127.0.0.1:${E2E_PORT}`;

/** The isolated PI directory used by the E2E test server. */
export const E2E_PI_DIR = process.env.BOBBIT_PI_DIR
	|| join(import.meta.dirname, "..", "..", ".e2e-pi");

/** Read the auth token that the test server auto-created on startup. */
export function readE2EToken(): string {
	return readFileSync(join(E2E_PI_DIR, "gateway-token"), "utf-8").trim();
}
