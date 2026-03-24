/**
 * @deprecated Use bobbit-dir.ts instead. This module is kept only for
 * backward compatibility. All new code should import from './bobbit-dir.js'.
 *
 * Central resolution of the `.pi` state directory.
 * Defaults to `~/.pi`. Tests can override by setting the `BOBBIT_PI_DIR`
 * environment variable to an isolated temp directory.
 */

import os from "node:os";
import path from "node:path";

/** @deprecated Use bobbitStateDir() from bobbit-dir.ts instead. */
export function piDir(): string {
	return process.env.BOBBIT_PI_DIR || path.join(os.homedir(), ".pi");
}
