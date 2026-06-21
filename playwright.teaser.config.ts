import { defineConfig } from "@playwright/test";

// Teaser recorder config. Drives the REAL Tauri app over CDP (like the e2e-lang
// suite) — the spec creates a new project from the landing page — against the
// developer's live DCS. There
// is NO Playwright video here — a CDP-attached WebView2 context can't be
// video-recorded — so the window is captured by ffmpeg (scripts/teaser-record.mjs).
// The spec paces itself with explicit waits so the take reads as a demo.
export default defineConfig({
  testDir: "teaser",
  workers: 1,
  timeout: 300_000,
  reporter: [["list"]],
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "node scripts/teaser-app.mjs",
    url: "http://localhost:9222/json/version",
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
