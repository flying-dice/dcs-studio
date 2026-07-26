import { defineConfig } from "vitest/config";

// Layer 2 of the pyramid — integration. Everything between the hexagon and the
// outside world: the node/vscode/github adapters, the panels that translate
// webview messages into core calls, the debug adapter's session shell, and the
// `extension.ts` composition root.
//
// "Integration" here means the seams are real code, not that the OS is: the
// `vscode` module is a shared test double (`test/integration/support/vscode.ts`)
// and process/network seams are injected. That keeps the layer fast and
// headless — it needs no VS Code instance, no display and no DCS — while still
// exercising the wiring that unit tests deliberately stub out.
//
// Runs standalone (`npm run test:integration`) and gates its own coverage at
// 100% per file over `src/**` minus the hexagon, which the unit layer owns.
export default defineConfig({
  test: {
    name: "integration",
    include: ["test/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // No `all` flag: vitest 4 dropped it, and the include globs below already
      // pull in a file nothing imports — which is the whole point of the gate,
      // and is verified by adding an unimported file and watching it fail at 0%.
      include: ["src/**"],
      exclude: ["src/core/**"],
      reportsDirectory: "coverage/integration",
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
