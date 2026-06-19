// The dcs-studio teaser speedrun — drives the REAL app over CDP against a
// pre-opened lua-script project (DCS_OPEN). The app injects the bridge and
// LAUNCHES DCS itself (the Injection Manager's "Launch DCS"), so the take shows
// the whole loop end-to-end. The WINDOW is captured by ffmpeg
// (scripts/teaser-record.mjs) — Playwright can't video a CDP-attached context.
// Paced with explicit waits so it reads as a demo, and LENIENT — a beat that
// can't reach a panel/the live sim is skipped, never failing the whole take.
// Each beat also drops a verification screenshot under teaser-results/.
//
//   node scripts/teaser-record.mjs
import { test, expect } from "../e2e-lang/_tauri";
import type { Locator, Page } from "@playwright/test";

const BASE = "http://localhost:1420";
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

let shotN = 0;
/** Save a verification screenshot of the webview state at this beat. */
const shot = (page: Page, name: string) =>
  page
    .screenshot({ path: `teaser-results/${String(++shotN).padStart(2, "0")}-${name}.png` })
    .catch(() => {});

/** Toggle a tool window by id (left/right/bottom rails carry data-testid="tool-<id>"). */
async function openTool(page: Page, id: string): Promise<void> {
  await page.getByTestId(`tool-${id}`).first().click().catch(() => {});
  await beat(page, 1000);
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
  // The app opened the teaser-mod project (DCS_OPEN) — wait for its file tree.
  await expect(page.getByRole("button", { name: "dcs-studio.toml" })).toBeVisible({ timeout: 90_000 });
  await beat(page, 1600);
  await shot(page, "workbench");

  // 1) Open the on-mission-start script (expand Scripts, then click the file).
  await page.getByRole("button", { name: "Scripts" }).first().click().catch(() => {});
  await beat(page, 900);
  await page.getByRole("button", { name: "on_mission_start.lua" }).first().click().catch(() => {});
  await beat(page, 1600);
  await shot(page, "script");

  // 2) Injection Manager: install the in-DCS bridge.
  await openTool(page, "inject");
  await shot(page, "inject-panel");
  await clickIf(page, /^(Inject|Update|Reinstall)/);
  await beat(page, 2500);
  await shot(page, "injected");

  // 3) Mission Scripting: desanitize so the mod's mission script can use io/lfs.
  await openTool(page, "mission");
  await clickIf(page, /Desanitize all/i);
  await beat(page, 1500);
  await shot(page, "desanitized");

  // 4) Back to Inject — LAUNCH DCS from the app, then wait for the live link.
  await openTool(page, "inject");
  await clickIf(page, /Launch DCS/i);
  await shot(page, "launching");
  await page
    .getByRole("button", { name: /Stop DCS/i })
    .first()
    .waitFor({ state: "visible", timeout: 180_000 })
    .catch(() => {});
  await beat(page, 3000);
  await shot(page, "dcs-live");

  // 5) REPL against the LIVE sim (hook env: DCS.*, lfs.*).
  await openTool(page, "repl");
  await runRepl(page, "return DCS.getModelTime()");
  await shot(page, "repl-modeltime");
  await runRepl(page, "return lfs.writedir()");
  await shot(page, "repl-writedir");

  // 6) DCS Log viewer — watch the sim's output; highlight + isolate the mod.
  await openTool(page, "dcslog");
  await beat(page, 1800);
  await shot(page, "dcs-log");
  const onlyMod = page.getByTestId("dcs-log-only-mod");
  if (await onlyMod.count()) {
    await onlyMod.first().click();
    await beat(page, 2500);
  }
  await shot(page, "dcs-log-mod");
});
