/**
 * Global teardown: remove the ephemeral .bobbit directory created for this test run.
 * Each run gets a unique `.e2e-bobbit-<id>` dir; this cleans it up after.
 */

import { rmSync } from "node:fs";

export default function globalTeardown() {
	const bobbitDir = process.env.BOBBIT_DIR;
	if (bobbitDir && bobbitDir.includes(".e2e-bobbit-")) {
		try {
			rmSync(bobbitDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup — don't fail the run if removal fails
		}
	}
}
