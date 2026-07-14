import { defineConfig, devices } from "@playwright/test";

// Playwright against the previews/ webview harnesses only — no VS Code, no
// Electron, no Rust sidecar. See previews/harness.js for why: the official
// @vscode/test-electron framework runs in the extension host and can't see
// webview DOM, so it doesn't fit data-testid UI testing.
//
// Chromium-only: webviews ship inside Electron's Chromium; firefox/webkit
// would test engines the code never runs in.
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/serve.mjs 4173",
    url: "http://127.0.0.1:4173/previews/skills.html",
    reuseExistingServer: !process.env.CI,
  },
});
