import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";

// Layer 3 of the pyramid — e2e. Specs import `test` from here rather than
// straight from @playwright/test so the real webview scripts under media/ can
// be measured: with E2E_COVERAGE set (npm run coverage:e2e), every page
// collects V8 JS coverage and dumps it raw for scripts/e2e-coverage.mjs to
// merge and gate. Without it the fixture is a pass-through, so the plain
// `npm run test:e2e` dev loop pays nothing for the instrumentation.

const COLLECT = !!process.env.E2E_COVERAGE;
const RAW_DIR = join(process.cwd(), "coverage", "e2e", "raw");

let counter = 0;

export const test = base.extend<{ page: import("@playwright/test").Page }>({
  page: async ({ page }, use, testInfo) => {
    if (!COLLECT) {
      await use(page);
      return;
    }
    // resetOnNavigation:false keeps counts across the harness's goto so a
    // script loaded before the first navigation is still attributed.
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    mkdirSync(RAW_DIR, { recursive: true });
    // One file per test: the merge step is what de-duplicates overlapping
    // hits, so parallel workers never contend on a shared file.
    const safe = testInfo.testId.replace(/[^a-z0-9]/gi, "");
    writeFileSync(
      join(RAW_DIR, `${safe}-${counter++}.json`),
      JSON.stringify(entries.filter((e) => e.url.includes("/media/"))),
    );
  },
});

export { expect };
