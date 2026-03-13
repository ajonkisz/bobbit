#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateToken, readToken } from "./auth/token.js";
import { createGateway } from "./server.js";

interface CliArgs {
	host: string;
	port: number;
	cwd: string;
	newToken: boolean;
	showToken: boolean;
	noUi: boolean;
	staticDir?: string;
	agentCliPath?: string;
}

/** Find the NordLynx (NordVPN mesh) interface IPv4 address, or null if not found. */
function findNordLynxIp(): string | null {
	const interfaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		if (!name.toLowerCase().includes("nordlynx")) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				return addr.address;
			}
		}
	}
	return null;
}

function parseArgs(argv: string[]): CliArgs {
	const result: CliArgs = {
		host: "",  // resolved after parsing
		port: 3001,
		cwd: process.cwd(),
		newToken: false,
		showToken: false,
		noUi: false,
	};

	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--host":
				result.host = argv[++i];
				break;
			case "--port":
				result.port = parseInt(argv[++i], 10);
				break;
			case "--cwd":
				result.cwd = path.resolve(argv[++i]);
				break;
			case "--new-token":
				result.newToken = true;
				break;
			case "--show-token":
				result.showToken = true;
				break;
			case "--static":
				result.staticDir = path.resolve(argv[++i]);
				break;
			case "--agent-cli":
				result.agentCliPath = path.resolve(argv[++i]);
				break;
			case "--no-ui":
				result.noUi = true;
				break;
		}
	}

	// Auto-detect embedded UI (dist/ui/) unless --no-ui or explicit --static
	if (!result.noUi && !result.staticDir) {
		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const embeddedUi = path.join(__dirname, "..", "ui");
		if (fs.existsSync(path.join(embeddedUi, "index.html"))) {
			result.staticDir = embeddedUi;
		}
	}

	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	// --show-token: print token and exit
	if (args.showToken) {
		const token = readToken();
		if (token) {
			console.log(token);
		} else {
			console.error("No token found. Run the gateway first to generate one.");
			process.exit(1);
		}
		return;
	}

	// Auto-detect NordLynx mesh IP if no --host was given
	if (!args.host) {
		const nordIp = findNordLynxIp();
		if (nordIp) {
			args.host = nordIp;
		} else {
			console.error(
				"Error: NordVPN mesh (NordLynx) interface not found.\n" +
				"  Start NordVPN, or pass --host <addr> to bind manually."
			);
			process.exit(1);
		}
	}

	const authToken = loadOrCreateToken(args.newToken);

	const gateway = createGateway({
		host: args.host,
		port: args.port,
		authToken,
		defaultCwd: args.cwd,
		staticDir: args.staticDir,
		agentCliPath: args.agentCliPath,
	});

	await gateway.start();

	// Collect reachable addresses for display
	const interfaces = os.networkInterfaces();
	const addresses: string[] = [];
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				addresses.push(`${addr.address} (${name})`);
			}
		}
	}

	const baseUrl = `http://${args.host}:${args.port}`;
	const fullUrl = `${baseUrl}/?token=${encodeURIComponent(authToken)}`;

	console.log(`\nPi Gateway v0.1.0`);
	console.log(`  Listening:  ${baseUrl}`);
	console.log(`  Auth token: ${authToken}`);
	console.log(`  Agent CWD:  ${args.cwd}`);
	if (args.staticDir) {
		console.log(`  UI:         ${fullUrl}`);
	}
	if (addresses.length > 0) {
		console.log(`  Accessible from: ${addresses.join(", ")}`);
	}
	console.log();
	console.log(`  \u26A0 This token grants full shell access to this machine.`);
	console.log(`  Keep it secret. Regenerate with --new-token.`);
	console.log();

	// Auto-open browser when serving the UI, passing token so the UI auto-connects
	if (args.staticDir) {
		const cmd =
			process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
		import("node:child_process").then(({ exec }) => exec(`${cmd} ${fullUrl}`));
	}

	// Graceful shutdown
	const shutdown = async () => {
		console.log("\nShutting down...");
		await gateway.shutdown();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
