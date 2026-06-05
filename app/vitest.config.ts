import { defineConfig } from "vitest/config";

// Standalone vitest config — deliberately does NOT load the SvelteKit plugin, so
// pure-TS unit tests (engine, live mapping) run in a plain node environment with
// no svelte-kit sync step.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/lib/**/*.test.ts"],
	},
});
