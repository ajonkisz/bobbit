import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ARTIFACTS_BASE = path.join(os.homedir(), ".pi", "workflow-artifacts");

/** Get the artifact directory for a session, creating it if needed */
export function getArtifactDir(sessionId: string): string {
	const dir = path.join(ARTIFACTS_BASE, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Store an artifact on disk. Returns the file path. */
export function storeArtifact(
	sessionId: string,
	filename: string,
	content: string | Buffer,
): string {
	const dir = getArtifactDir(sessionId);
	const filePath = path.join(dir, filename);
	fs.writeFileSync(filePath, content, typeof content === "string" ? "utf-8" : undefined);
	return filePath;
}

/** Read an artifact from disk */
export function readArtifact(sessionId: string, filename: string): Buffer | null {
	const dir = path.join(ARTIFACTS_BASE, sessionId);
	const filePath = path.join(dir, filename);

	// Prevent traversal
	if (!path.resolve(filePath).startsWith(path.resolve(dir))) return null;

	try {
		return fs.readFileSync(filePath);
	} catch {
		return null;
	}
}

/** List artifact files for a session */
export function listArtifactFiles(sessionId: string): string[] {
	const dir = path.join(ARTIFACTS_BASE, sessionId);
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/** Remove all artifacts for a session */
export function cleanupArtifacts(sessionId: string): void {
	const dir = path.join(ARTIFACTS_BASE, sessionId);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}
