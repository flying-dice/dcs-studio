import { defineConfig } from "@playwright/test";

// Language-engine suite: browser-only (wasm in the page), no Tauri, no DCS —
// so no global-setup that launches the sim. Run with `pnpm test:lang`.
export default defineConfig({
  testDir: "e2e-lang",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    port: 1420,
    reuseExistingServer: true,
    // Cold vite starts (dependency optimisation, fresh wasm) can crawl;
    // TIME_WAIT remnants of a previous server also delay the port.
    timeout: 120_000,
  },
});
