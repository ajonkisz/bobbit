import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_DIR = path.join(os.homedir(), ".pi");
const CERT_PATH = path.join(PI_DIR, "gateway-cert.pem");
const KEY_PATH = path.join(PI_DIR, "gateway-key.pem");

/** Resolve the openssl binary, checking Git-bundled locations on Windows. */
function resolveOpenssl(): string {
	if (process.platform !== "win32") return "openssl";

	// Check if openssl is already on PATH
	try {
		execSync("openssl version", { stdio: "pipe" });
		return "openssl";
	} catch {}

	// Common Git for Windows bundled locations
	const candidates = [
		path.join("C:", "Program Files", "Git", "usr", "bin", "openssl.exe"),
		path.join("C:", "Program Files", "Git", "mingw64", "bin", "openssl.exe"),
		path.join("C:", "Program Files (x86)", "Git", "usr", "bin", "openssl.exe"),
	];
	for (const p of candidates) {
		if (fs.existsSync(p)) return `"${p}"`;
	}

	return "openssl"; // fall through — will produce the original error
}

export interface TlsFiles {
	cert: string;
	key: string;
}

/**
 * Ensure a self-signed TLS certificate exists for the given host IP.
 * Generates one with `openssl` if missing or if the IP has changed.
 * Returns paths to the cert and key files.
 */
export function ensureTlsCert(host: string): TlsFiles {
	fs.mkdirSync(PI_DIR, { recursive: true });

	if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
		// Check if existing cert covers the current host IP
		if (certCoversHost(CERT_PATH, host)) {
			return { cert: CERT_PATH, key: KEY_PATH };
		}
		console.log(`  TLS cert does not cover ${host}, regenerating...`);
	}

	generateSelfSignedCert(host);
	return { cert: CERT_PATH, key: KEY_PATH };
}

function generateSelfSignedCert(host: string): void {
	console.log(`  Generating self-signed TLS certificate for ${host}...`);

	const openssl = resolveOpenssl();

	// Build SAN: always include the IP, plus localhost for local dev
	const san = `subjectAltName=IP:${host},IP:127.0.0.1,DNS:localhost`;

	try {
		execSync(
			[
				openssl, "req",
				"-x509",
				"-newkey", "ec",
				"-pkeyopt", "ec_paramgen_curve:prime256v1",
				"-nodes",
				"-days", "3650",
				"-subj", `"/CN=bobbit"`,
				"-addext", `"${san}"`,
				"-keyout", `"${KEY_PATH}"`,
				"-out", `"${CERT_PATH}"`,
			].join(" "),
			{ stdio: "pipe" },
		);
	} catch (err: any) {
		// Try alternate openssl syntax for older versions that don't support -addext
		try {
			// Write a minimal openssl config with SAN
			const cnfPath = path.join(PI_DIR, "gateway-openssl.cnf");
			fs.writeFileSync(cnfPath, [
				"[req]",
				"distinguished_name = req_dn",
				"x509_extensions = v3_ext",
				"prompt = no",
				"",
				"[req_dn]",
				"CN = bobbit",
				"",
				"[v3_ext]",
				`subjectAltName = IP:${host},IP:127.0.0.1,DNS:localhost`,
			].join("\n"));

			execSync(
				[
					openssl, "req",
					"-x509",
					"-newkey", "ec",
					"-pkeyopt", "ec_paramgen_curve:prime256v1",
					"-nodes",
					"-days", "3650",
					"-config", `"${cnfPath}"`,
					"-keyout", `"${KEY_PATH}"`,
					"-out", `"${CERT_PATH}"`,
				].join(" "),
				{ stdio: "pipe" },
			);
			fs.unlinkSync(cnfPath);
		} catch (err2: any) {
			throw new Error(
				`Failed to generate TLS certificate. Is openssl installed?\n` +
				`  ${err2.stderr?.toString() || err2.message}`,
			);
		}
	}

	// Restrict key permissions (owner-only on Unix)
	if (process.platform !== "win32") {
		fs.chmodSync(KEY_PATH, 0o600);
		fs.chmodSync(CERT_PATH, 0o644);
	}

	console.log(`  TLS cert: ${CERT_PATH}`);
	console.log(`  TLS key:  ${KEY_PATH}`);
}

/** Check if an existing cert's SAN includes the given host IP. */
function certCoversHost(certPath: string, host: string): boolean {
	try {
		const openssl = resolveOpenssl();
		const out = execSync(
			`${openssl} x509 -in "${certPath}" -noout -ext subjectAltName`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		// Output looks like: "IP Address:100.64.x.x, IP Address:127.0.0.1, DNS:localhost"
		return out.includes(`IP Address:${host}`);
	} catch {
		return false;
	}
}
