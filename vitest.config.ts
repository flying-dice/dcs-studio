import { defineConfig } from "vitest/config";

// Standalone unit-test config (separate from the SvelteKit vite.config) for the
// pure, runes-free logic in src/lib/*.ts — no DOM, no svelte plugin needed.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
