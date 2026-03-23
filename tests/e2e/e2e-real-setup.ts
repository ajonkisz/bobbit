/**
 * Shared helpers for "real LLM" E2E tests.
 *
 * These tests run against an isolated gateway on port 3097 with
 * BOBBIT_DIR pointing to `.e2e-real-bobbit` — must match
 * tests/playwright-e2e.config.ts.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The isolated .bobbit directory used by the real-LLM E2E test server. */
export const E2E_REAL_BOBBIT_DIR = join(__dirname, "..", "..", ".e2e-real-bobbit");

// Legacy alias
export const E2E_REAL_PI_DIR = E2E_REAL_BOBBIT_DIR;

/** Gateway base URL for direct API calls (no UI). */
export const REAL_GW_URL = "http://localhost:3097";

/** Read the auth token that the isolated test server auto-created on startup. */
export function readRealE2EToken(): string {
	return readFileSync(join(E2E_REAL_BOBBIT_DIR, "state", "token"), "utf-8").trim();
}
