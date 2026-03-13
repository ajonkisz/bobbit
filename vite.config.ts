import tailwindcss from "@tailwindcss/vite";
import os from "node:os";
import { defineConfig } from "vite";

/** Find the NordLynx (NordVPN mesh) interface IPv4 address. */
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

const meshIp = findNordLynxIp();
const host = process.env.VITE_HOST || meshIp || "localhost";
const GATEWAY = process.env.GATEWAY_URL || `http://${host}:3001`;
const GATEWAY_WS = GATEWAY.replace(/^http/, "ws");

if (!meshIp && !process.env.VITE_HOST) {
	console.warn("Warning: NordLynx interface not found. Vite will bind to localhost.");
	console.warn("  Start NordVPN, or set VITE_HOST manually.\n");
}

export default defineConfig({
	plugins: [tailwindcss()],
	build: {
		outDir: "dist/ui",
	},
	server: {
		host,
		proxy: {
			"/api": {
				target: GATEWAY,
				changeOrigin: true,
			},
			"/ws": {
				target: GATEWAY_WS,
				ws: true,
			},
		},
	},
});
