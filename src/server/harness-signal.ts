#!/usr/bin/env node

/**
 * Sends a restart signal to the dev server harness by touching the sentinel file.
 *
 * Usage:
 *   node dist/server/harness-signal.js
 *   npm run restart-server
 */

import fs from "node:fs";
import path from "node:path";
import { piDir } from "./pi-dir.js";

const SENTINEL = path.join(piDir(), "gateway-restart");

const dir = path.dirname(SENTINEL);
if (!fs.existsSync(dir)) {
	fs.mkdirSync(dir, { recursive: true });
}

// Write a timestamp to change the mtime
fs.writeFileSync(SENTINEL, Date.now().toString(), "utf-8");
console.log("[restart-server] Signal sent — harness will rebuild and restart.");
