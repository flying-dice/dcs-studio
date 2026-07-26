import { defineConfig } from "vitest/config";

// Dev-convenience entry point only: a bare `vitest` (or an IDE's Vitest
// integration) runs both TypeScript layers side by side with their names in
// the reporter. It deliberately declares NO coverage config — each layer gates
// its own percentage against its own include set, and merging them would make
// a gap in one layer look covered by the other. CI and `npm run coverage` use
// vitest.unit.config.ts and vitest.integration.config.ts directly.
export default defineConfig({
  test: {
    projects: ["vitest.unit.config.ts", "vitest.integration.config.ts"],
  },
});
