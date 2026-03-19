import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_DIR = path.join(os.homedir(), ".pi");
const TLS_DIR = path.join(PI_DIR, "gateway-tls");
const CERT_PATH = path.join(PI_DIR, "gateway-cert.pem");
const KEY_PATH = path.join(PI_DIR, "gateway-key.pem");

// mkcert CA files
const CA_CERT_PATH = path.join(TLS_DIR, "ca.crt");
const CA_KEY_PATH = path.join(TLS_DIR, "ca.key");

/** Resolve the openssl binary, checking Git-bundled locations on Windows. */
function resolveOpenssl(): string {
	if (process.platform !== "win32") return "openssl";

	// Check if openssl is already on PATH
	try {
		execSync("openssl version", { stdio: "pipe", shell: true as unknown as string });
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
	/** Path to CA certificate, if generated via mkcert. Users install this to trust the cert. */
	caCert?: string;
}

/**
 * Ensure a TLS certificate exists for the given host IP.
 *
 * Strategy:
 *   1. Try mkcert (npm package) — generates a local CA + cert trusted by browsers
 *      once the CA cert is installed on the device.
 *   2. Fall back to openssl self-signed cert (existing behavior).
 *
 * Returns paths to the cert, key, and optionally the CA cert.
 */
export async function ensureTlsCert(host: string): Promise<TlsFiles> {
	fs.mkdirSync(PI_DIR, { recursive: true });
	fs.mkdirSync(TLS_DIR, { recursive: true });

	// If existing cert covers this host, reuse it
	if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
		if (certCoversHost(CERT_PATH, host)) {
			const caCert = fs.existsSync(CA_CERT_PATH) ? CA_CERT_PATH : undefined;
			return { cert: CERT_PATH, key: KEY_PATH, caCert };
		}
		console.log(`  TLS cert does not cover ${host}, regenerating...`);
	}

	// Try mkcert first, fall back to openssl
	try {
		return await generateMkcertCert(host);
	} catch (err: any) {
		console.log(`  mkcert unavailable (${err.message}), falling back to openssl self-signed cert`);
		return generateSelfSignedCert(host);
	}
}

/**
 * Generate a CA + cert using the mkcert npm package.
 * The CA cert can be installed on devices to trust all Bobbit certs.
 */
async function generateMkcertCert(host: string): Promise<TlsFiles> {
	// Dynamic import — fails fast if mkcert isn't installed
	const { createCA, createCert } = await import("mkcert");

	// Reuse existing CA if available, otherwise create one
	let caCert: string;
	let caKey: string;

	if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
		console.log(`  Reusing existing Bobbit CA from ${TLS_DIR}`);
		caCert = fs.readFileSync(CA_CERT_PATH, "utf-8");
		caKey = fs.readFileSync(CA_KEY_PATH, "utf-8");
	} else {
		console.log(`  Creating Bobbit local CA...`);
		const ca = await createCA({
			organization: "Bobbit Local CA",
			countryCode: "US",
			state: "Local",
			locality: "Local",
			validity: 3650,
		});
		caCert = ca.cert;
		caKey = ca.key;
		fs.writeFileSync(CA_CERT_PATH, caCert);
		fs.writeFileSync(CA_KEY_PATH, caKey);
		if (process.platform !== "win32") {
			fs.chmodSync(CA_KEY_PATH, 0o600);
		}
		console.log(`  CA cert: ${CA_CERT_PATH}`);
	}

	// Generate a cert for this host signed by our CA
	console.log(`  Generating mkcert TLS certificate for ${host}...`);
	const cert = await createCert({
		ca: { cert: caCert, key: caKey },
		domains: [host, "127.0.0.1", "localhost"],
		validity: 3650,
	});

	fs.writeFileSync(CERT_PATH, cert.cert);
	fs.writeFileSync(KEY_PATH, cert.key);
	if (process.platform !== "win32") {
		fs.chmodSync(KEY_PATH, 0o600);
		fs.chmodSync(CERT_PATH, 0o644);
	}

	console.log(`  TLS cert: ${CERT_PATH} (signed by Bobbit CA)`);
	console.log(`  TLS key:  ${KEY_PATH}`);
	console.log(`  Install ${CA_CERT_PATH} on other devices to trust this certificate.`);

	return { cert: CERT_PATH, key: KEY_PATH, caCert: CA_CERT_PATH };
}

function generateSelfSignedCert(host: string): TlsFiles {
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
			{ stdio: "pipe", shell: true as unknown as string },
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
				{ stdio: "pipe", shell: true as unknown as string },
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

	return { cert: CERT_PATH, key: KEY_PATH };
}

/** Check if an existing cert's SAN includes the given host IP. */
function certCoversHost(certPath: string, host: string): boolean {
	try {
		const openssl = resolveOpenssl();
		const out = execSync(
			`${openssl} x509 -in "${certPath}" -noout -ext subjectAltName`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: true as unknown as string },
		);
		// Output looks like: "IP Address:100.64.x.x, IP Address:127.0.0.1, DNS:localhost"
		return out.includes(`IP Address:${host}`);
	} catch {
		return false;
	}
}
