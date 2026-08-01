import { defineConfig, devices } from "@playwright/test";

// Playwright against the previews/ webview harnesses only — no VS Code, no
// Electron, no Rust sidecar. See previews/harness.js for why: the official
// @vscode/test-electron framework runs in the extension host and can't see
// webview DOM, so it doesn't fit data-testid UI testing.
//
// Chromium-only: webviews ship inside Electron's Chromium; firefox/webkit
// would test engines the code never runs in.
// One source for the preview server's address: baseURL, the readiness probe and
// the command that starts it all have to agree, and a mismatch shows up as the
// whole suite timing out rather than as a wrong port.
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: ORIGIN,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Images that ship their own Chromium (CI containers, nix, locked-down
        // corporate builds) can point at it instead of Playwright's download.
        //
        // The revision is pinned by the @playwright/test version, not by this
        // file: 1.62.1 wants chromium-1234, where 1.61.1 wanted 1228. So a
        // hardcoded PW_CHROMIUM_PATH goes stale on a Playwright bump and the
        // whole suite fails to launch. Leave it unset and let Playwright
        // resolve its own download (`npx playwright install chromium` after a
        // bump); set it only when there is a browser Playwright cannot find.
        // On Windows the cache is
        // %LOCALAPPDATA%\ms-playwright\chromium-<rev>\chrome-win64\chrome.exe.
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `node scripts/serve.mjs ${PORT}`,
    url: `${ORIGIN}/previews/skills.html`,
    reuseExistingServer: !process.env.CI,
  },
});
