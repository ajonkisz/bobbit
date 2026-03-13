import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	timeout: 15_000,
});
