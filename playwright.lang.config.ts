import { defineConfig } from "@playwright/test";

// Language-engine suite (issue #32): drives the REAL packaged Tauri app over
// CDP, so the specs exercise the hosted `lua-analyzer` engine the IDE ships —
// not a wasm build of it in a plain browser. `scripts/e2e-app.mjs` launches
// `tauri dev` with WebView2 remote debugging on :9222; the fixture
// (`e2e-lang/_tauri.ts`) attaches Playwright to that CDP endpoint.
//
// No DCS: nothing here touches the sim. Heavier than the old browser-only run
// (a real app boot + lua-analyzer spawn), so one worker, generous timeouts.
export default defineConfig({
  testDir: "e2e-lang",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-app.mjs",
    // The CDP endpoint comes up once WebView2 has booted — readiness for the
    // whole app (cargo build + vite + window). 2xx/4xx both count as ready.
    url: "http://localhost:9222/json/version",
    reuseExistingServer: true,
    // A cold incremental `tauri dev` (cargo build + vite optimise) can crawl.
    timeout: 300_000,
  },
});
