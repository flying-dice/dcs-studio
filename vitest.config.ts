import { defineConfig } from "vitest/config";

// Dev-convenience entry point only: a bare `vitest` (or an IDE's Vitest
// integration) runs both TypeScript layers side by side with their names in
// the reporter. It deliberately declares NO coverage config — each layer gates
// its own percentage against its own include set, and merging them would make
// a gap in one layer look covered by the other. CI and `npm run coverage` use
// vitest.unit.config.ts and vitest.integration.config.ts directly.

// Asking for coverage here is the one catastrophic way to use this file, and
// until now nothing stopped it. Vitest treats `coverage` as a root-only option,
// so under a `projects` config every per-layer threshold is silently ignored:
// coverage is computed, printed, and discarded, and the command exits 0 no
// matter how bad the numbers are. That is not hypothetical — it is how a
// release workflow gated nothing for a while, looking green the entire time.
//
// The failure mode is silence, so the fix has to be noise. Refuse to load.
const coverageRequested =
  process.argv
    .slice(2)
    .some(
      (arg) =>
        arg === "--coverage" || arg.startsWith("--coverage.") || arg.startsWith("--coverage="),
    ) || process.env.VITEST_COVERAGE !== undefined;

if (coverageRequested) {
  throw new Error(
    [
      "Refusing to measure coverage from the root vitest config.",
      "",
      "This is a `projects` config, and vitest treats `coverage` as a root-only",
      "option — every per-layer threshold would be silently ignored and the run",
      "would pass whatever the numbers said. A release workflow once gated",
      "nothing for exactly this reason.",
      "",
      "Use the per-layer gates instead, and run them serially:",
      "  npm run coverage:unit",
      "  npm run coverage:integration",
      "  npm run coverage:e2e",
      "  (and `cargo llvm-cov` via `node scripts/llvm-cov.mjs` for the bridge)",
      "",
      "`npm run coverage` runs the three JavaScript layers in order.",
      "See docs/02-guides/01-running-the-tests.md.",
    ].join("\n"),
  );
}

export default defineConfig({
  test: {
    projects: ["vitest.unit.config.ts", "vitest.integration.config.ts"],
  },
});
