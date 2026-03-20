/**
 * Central resolution of the `.pi` state directory.
 *
 * Defaults to `~/.pi`. Tests can override by setting the `BOBBIT_PI_DIR`
 * environment variable to an isolated temp directory so they don't pollute
 * the real dev-server state.
 */

import os from "node:os";
import path from "node:path";

export function piDir(): string {
	return process.env.BOBBIT_PI_DIR || path.join(os.homedir(), ".pi");
}
