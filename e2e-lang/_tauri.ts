// Shared fixture for the e2e-lang suite (issue #32).
//
// These specs drive the REAL packaged app, not a browser with the engine
// compiled to wasm. In the real Tauri shell `isTauri()` is true, so the Lua
// provider is the hosted `lua-analyzer` (decisions/005, revised) — the same
// engine the IDE ships — reached over LSP, exactly as a user meets it.
//
// Transport is CDP: `scripts/e2e-app.mjs` launches `tauri dev` with WebView2
// remote debugging on :9222 (the only e2e transport that works against
// WebView2, hence Windows-only); we attach Playwright to that endpoint and
// override the built-in `page` fixture with the real WebView2 page, so specs
// keep `async ({ page })` and the full auto-retrying `@playwright/test`
// expect. Only their import line and absolute navigation change — the CDP
// page is not the test-managed context, so relative `goto` has no baseURL;
// use `labUrl`.
import {
  test as base,
  expect,
  chromium,
  type Browser,
  type Page,
} from "@playwright/test";

/** The app's frontend origin under `tauri dev` (vite). */
export const BASE = "http://localhost:1420";

/** Absolute URL for a lab route, e.g. `labUrl("lua")` → the Lua lab page. */
export const labUrl = (route: string): string => `${BASE}/lab/${route}`;

/** WebView2's Chrome DevTools Protocol endpoint (see scripts/e2e-app.mjs). */
const CDP_ENDPOINT = "http://localhost:9222";

export const test = base.extend<{ page: Page }, { cdpBrowser: Browser }>({
  // Attach to the running app's WebView2 over CDP ONCE per worker, not per
  // test. `connectOverCDP` only attaches — closing it disconnects Playwright,
  // never the app (the webServer owns that). Reconnecting for all 88 specs
  // churned WebView2's CDP and degraded late specs into timeouts; one
  // connection for the whole run keeps every spec as fast as the first.
  cdpBrowser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
      // Install the confirm test seam (state.svelte.ts) on every document the
      // app loads: the real app's discard confirm is a native Tauri dialog CDP
      // can neither read nor answer. The probe records each prompt and answers
      // it per `window.__dcsConfirmAnswer__` (default NO — never silently
      // discard). Specs drive it through `armConfirm`/`confirmPrompts` below.
      const context = browser.contexts()[0];
      const page = context?.pages()[0] ?? (await context.newPage());
      await page.addInitScript(() => {
        const w = window as unknown as {
          __dcsConfirmCalls__?: string[];
          __dcsConfirmAnswer__?: boolean;
          __dcsConfirm__?: (m: string) => Promise<boolean>;
        };
        w.__dcsConfirmCalls__ = [];
        w.__dcsConfirm__ = (message: string) => {
          (w.__dcsConfirmCalls__ ??= []).push(message);
          return Promise.resolve(w.__dcsConfirmAnswer__ === true);
        };
      });
      await use(browser);
      await browser.close();
    },
    { scope: "worker" },
  ],
  page: async ({ cdpBrowser }, use) => {
    const context = cdpBrowser.contexts()[0];
    const page = context?.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

/** Arm the discard-confirm seam before an action that may prompt: set the
 *  answer (accept/decline) and clear the recorded prompts. */
export async function armConfirm(page: Page, accept: boolean): Promise<void> {
  await page.evaluate((answer) => {
    const w = window as unknown as {
      __dcsConfirmCalls__: string[];
      __dcsConfirmAnswer__: boolean;
    };
    w.__dcsConfirmAnswer__ = answer;
    w.__dcsConfirmCalls__ = [];
  }, accept);
}

/** The discard-confirm messages recorded since the last `armConfirm`. */
export async function confirmPrompts(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __dcsConfirmCalls__?: string[] })
        .__dcsConfirmCalls__ ?? [],
  );
}

export { expect };
