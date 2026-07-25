import { defineConfig } from "vitest/config";

// Layer 1 of the pyramid — unit. Pure logic only: the hexagon (`src/core/**`)
// and the two framework-free webview cores that both the extension and the
// browser load (`media/*-core.js`). No filesystem, no child processes, no
// `vscode`; anything that needs a seam belongs in the integration layer.
//
// Runs standalone (`npm run test:unit`) and gates its own coverage at 100%
// per file — this layer's include set is disjoint from the integration and
// e2e layers', so each layer's percentage means something on its own.
export default defineConfig({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/core/**", "media/explorer-core.js", "media/manifest-core.js"],
      reportsDirectory: "coverage/unit",
      thresholds: {
        perFile: true,
        lines: 100,
        functions: 100,
        statements: 100,
        branches: 100,
      },
    },
  },
});
