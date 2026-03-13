import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const GATEWAY = process.env.GATEWAY_URL || "http://localhost:3001";
const GATEWAY_WS = GATEWAY.replace(/^http/, "ws");

export default defineConfig({
	plugins: [tailwindcss()],
	build: {
		outDir: "dist/ui",
	},
	server: {
		host: process.env.VITE_HOST || "localhost",
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
