/**
 * Global teardown: remove the ephemeral PI directory created for this test run.
 * Each run gets a unique `.e2e-pi-<id>` dir; this cleans it up after.
 */

import { rmSync } from "node:fs";

export default function globalTeardown() {
	const piDir = process.env.BOBBIT_PI_DIR;
	if (piDir && piDir.includes(".e2e-pi-")) {
		try {
			rmSync(piDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup — don't fail the run if removal fails
		}
	}
}
