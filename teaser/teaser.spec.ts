// The dcs-studio teaser speedrun — drives the REAL app over CDP against a
// pre-opened lua-script project (DCS_OPEN) + the developer's live DCS. The
// WINDOW is captured by ffmpeg (scripts/teaser-record.mjs); Playwright can't
// video a CDP-attached context. Paced with explicit waits so it reads as a demo,
// and LENIENT — a beat that can't reach a panel/the live sim is skipped, never
// failing the whole take.
//
// Run via:  node scripts/teaser-record.mjs   (needs DCS + the bridge up)
import { test, expect } from "../e2e-lang/_tauri";
import type { Locator, Page } from "@playwright/test";

const BASE = "http://localhost:1420";
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

/** Open a tool window by its label, tolerant of how the toggle is queried. */
async function openTool(page: Page, label: string): Promise<void> {
  for (const loc of [
    page.getByRole("button", { name: label, exact: true }),
    page.locator(`button[title="${label}"]`),
    page.getByRole("button", { name: label }),
  ]) {
    if (await loc.count()) {
      await loc.first().click().catch(() => {});
      break;
    }
  }
  await beat(page, 900);
}

/** Type into a CodeMirror input at a human cadence. */
async function typeSlow(loc: Locator, text: string): Promise<void> {
  await loc.click();
  await loc.pressSequentially(text, { delay: 45 });
}

async function runRepl(page: Page, code: string): Promise<void> {
  const input = page.getByTestId("lua-console-input").locator(".cm-content");
  await input.click();
  await page.keyboard.press("Control+A");
  await typeSlow(input, code);
  await beat(page, 600);
  await page.getByTestId("lua-console-run").click();
  await beat(page, 1800);
}

test("dcs-studio speedrun", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${BASE}/`);
  // The app opened the teaser-mod project (DCS_OPEN) — wait for the workbench.
  await expect(page.getByTestId("editor-tab").first()).toBeVisible({ timeout: 90_000 });
  await beat(page, 1600);

  // 1) Show the on-mission-start script in the editor.
  const file = page
    .getByTestId("tree-node")
    .filter({ hasText: "on_mission_start" })
    .first();
  if (await file.count()) {
    await file.click();
    await beat(page, 1500);
  }

  // 2) REPL against the LIVE sim (hook env: DCS.*, lfs.*).
  await openTool(page, "REPL");
  await runRepl(page, "return DCS.getModelTime()");
  await runRepl(page, "return lfs.writedir()");

  // 3) Mission Scripting — desanitize so a mission script can use io/lfs/etc.
  await openTool(page, "Mission");
  await beat(page, 900);
  const desanitize = page.getByRole("button", { name: /Desanitize all/i }).first();
  if ((await desanitize.count()) && (await desanitize.isEnabled().catch(() => false))) {
    await desanitize.click();
    await beat(page, 1500);
  }

  // 4) DCS Log viewer — highlight + isolate the current mod's lines.
  await openTool(page, "DCS Log");
  await beat(page, 1600);
  const onlyMod = page.getByTestId("dcs-log-only-mod");
  if (await onlyMod.count()) {
    await onlyMod.first().click();
    await beat(page, 2200);
  }

  // 5) Injection / launch — show the live DCS link, then launch if not running.
  await openTool(page, "Inject");
  await beat(page, 1500);
  const launch = page.getByRole("button", { name: /Launch DCS/i }).first();
  if ((await launch.count()) && (await launch.isEnabled().catch(() => false))) {
    await launch.click();
  }
  await beat(page, 2500);
});
