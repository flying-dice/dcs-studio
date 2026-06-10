import { defineConfig } from "@playwright/test";

// E2E suite that drives the real UI against a real DCS instance via the
// in-DCS bridge (ws://127.0.0.1:25569). global-setup launches DCS when the
// bridge isn't already up, so a full cold run takes ~1 min before first test.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup",
  globalTeardown: "./e2e/global-teardown",
  // One worker: every test talks to the same single DCS instance.
  workers: 1,
  timeout: 60_000,
  // Console progress + an HTML report (videos attached per test) under
  // playwright-report/. Serve it with `pnpm test:e2e:report` / `show-report`.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:1420",
    // Artifacts under test-results/: every test keeps a video; screenshots and
    // traces (`pnpm exec playwright show-trace <trace.zip>`) only on failure.
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    port: 1420,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
