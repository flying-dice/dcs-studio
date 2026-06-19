// The dcs-studio teaser speedrun — drives the REAL app over CDP against a
// pre-opened lua-script project (DCS_OPEN). The app injects the bridge and
// LAUNCHES DCS itself (the Injection Manager's "Launch DCS"), so the take shows
// the whole loop end-to-end. The WINDOW is captured by ffmpeg
// (scripts/teaser-record.mjs) — Playwright can't video a CDP-attached context.
// Paced with explicit waits so it reads as a demo, and LENIENT — a beat that
// can't reach a panel/the live sim is skipped, never failing the whole take.
//
//   node scripts/teaser-record.mjs
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

/** Click the first matching, enabled button; returns whether it fired. */
async function clickIf(page: Page, name: RegExp): Promise<boolean> {
  const b = page.getByRole("button", { name }).first();
  if ((await b.count()) && (await b.isEnabled().catch(() => false))) {
    await b.click().catch(() => {});
    return true;
  }
  return false;
}

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
  test.setTimeout(360_000);
  await page.goto(`${BASE}/`);
  // The app opened the teaser-mod project (DCS_OPEN) — wait for the workbench.
  await expect(page.getByTestId("editor-tab").first()).toBeVisible({ timeout: 90_000 });
  await beat(page, 1600);

  // 1) Show the on-mission-start script in the editor.
  const file = page.getByTestId("tree-node").filter({ hasText: "on_mission_start" }).first();
  if (await file.count()) {
    await file.click();
    await beat(page, 1600);
  }

  // 2) Injection Manager: install the in-DCS bridge, then LAUNCH DCS from the
  //    app (windowed, low-spec). This is the "launch the sim" beat.
  await openTool(page, "Inject");
  await beat(page, 900);
  await clickIf(page, /^(Inject|Update|Reinstall)/);
  await beat(page, 2000);

  // 3) Mission Scripting: desanitize so the mod's mission script can use io/lfs.
  await openTool(page, "Mission");
  await beat(page, 900);
  await clickIf(page, /Desanitize all/i);
  await beat(page, 1500);

  // 4) Back to Inject — launch DCS, then wait for the live link (the bridge
  //    answers from boot; "Stop DCS" appears + the footer link goes live).
  await openTool(page, "Inject");
  await beat(page, 700);
  await clickIf(page, /Launch DCS/i);
  // DCS cold start: wait (up to ~3 min) for the running indicator.
  await page
    .getByRole("button", { name: /Stop DCS/i })
    .first()
    .waitFor({ state: "visible", timeout: 180_000 })
    .catch(() => {});
  await beat(page, 2500);

  // 5) REPL against the LIVE sim (hook env: DCS.*, lfs.*).
  await openTool(page, "REPL");
  await runRepl(page, "return DCS.getModelTime()");
  await runRepl(page, "return lfs.writedir()");

  // 6) DCS Log viewer — watch the sim's output; highlight + isolate the mod.
  await openTool(page, "DCS Log");
  await beat(page, 1800);
  const onlyMod = page.getByTestId("dcs-log-only-mod");
  if (await onlyMod.count()) {
    await onlyMod.first().click();
    await beat(page, 2500);
  }
});
