import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { piDir } from "../pi-dir.js";

const TOKEN_DIR = piDir();
const TOKEN_FILE = path.join(TOKEN_DIR, "gateway-token");

export function generateToken(): string {
	return crypto.randomBytes(32).toString("hex"); // 256 bits = 64 hex chars
}

export function loadOrCreateToken(forceNew = false): string {
	if (!forceNew) {
		try {
			const token = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
			if (token.length >= 64) return token;
		} catch {
			// Token file doesn't exist yet
		}
	}

	const token = generateToken();
	fs.mkdirSync(TOKEN_DIR, { recursive: true });
	fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
	return token;
}

export function readToken(): string | null {
	try {
		const token = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
		return token.length >= 64 ? token : null;
	} catch {
		return null;
	}
}

/** Constant-time token comparison to prevent timing attacks */
export function validateToken(provided: string, expected: string): boolean {
	if (provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
