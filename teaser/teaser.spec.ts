// The dcs-studio teaser speedrun — drives the REAL app over CDP against a
// pre-opened lua-script project (DCS_OPEN). The app injects the bridge and
// LAUNCHES DCS itself (the Injection Manager's "Launch DCS"), then we add a
// hello-world, run the mod in DCS (the return lands in the Console), eval the
// live sim in the REPL, and watch the mod's line in the DCS Log viewer. The
// WINDOW is captured by ffmpeg (scripts/teaser-record.mjs) — Playwright can't
// video a CDP-attached context; scripts/teaser-focus.ps1 keeps the IDE in front.
// Paced + LENIENT: a beat that can't reach a panel/the live sim is skipped, never
// failing the whole take. Each beat drops a screenshot under teaser-results/.
//
//   node scripts/teaser-record.mjs
import { test, expect } from "../e2e-lang/_tauri";
import type { Page } from "@playwright/test";

const BASE = "http://localhost:1420";
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

let shotN = 0;
const shot = (page: Page, name: string) =>
  page
    .screenshot({ path: `teaser-results/${String(++shotN).padStart(2, "0")}-${name}.png` })
    .catch(() => {});

/** Toggle a tool window by id (rails carry data-testid="tool-<id>"). */
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

async function runRepl(page: Page, code: string): Promise<void> {
  const input = page.getByTestId("lua-console-input").locator(".cm-content");
  await input.click();
  // Clear without re-clicking (a re-click drops the select-all, appending code).
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(code, { delay: 45 });
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

  // 1) Open the mod's hello script.
  await page.getByRole("button", { name: "Scripts" }).first().click().catch(() => {});
  await beat(page, 900);
  await page.getByRole("button", { name: "hello.lua" }).first().click().catch(() => {});
  await beat(page, 1600);
  await shot(page, "script");

  // 2) Install the in-DCS bridge.
  await openTool(page, "inject");
  await shot(page, "inject-panel");
  await clickIf(page, /^(Inject|Update|Reinstall)/);
  await beat(page, 2500);
  await shot(page, "injected");

  // 3) Desanitize mission scripting.
  await openTool(page, "mission");
  await clickIf(page, /Desanitize all/i);
  await beat(page, 1500);
  await shot(page, "desanitized");

  // 4) Launch DCS from the app, then wait for the live link (skip if already up).
  await openTool(page, "inject");
  const link = () => page.getByText(/DCS:\s*connected|mission running/i).first();
  if (!(await link().isVisible().catch(() => false))) {
    await clickIf(page, /Launch DCS/i);
    await shot(page, "launching");
    await link().waitFor({ state: "visible", timeout: 240_000 }).catch(() => {});
  }
  await beat(page, 3000);
  await shot(page, "dcs-live");

  // 5) Add a hello-world to the script, then RUN THE MOD IN DCS — the return
  //    value lands in the Console.
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type('return "Hello, world!"', { delay: 55 });
  await beat(page, 1000);
  await shot(page, "hello-typed");

  // Run the file in DCS via the editor keybinding (Mod-Enter) — robust vs the
  // toolbar selector (and the top-bar "Run" is a MENU, not a run action). Falls
  // back to the editor's Run button if the keybinding didn't land.
  await editor.click();
  await page.keyboard.press("Control+Enter");
  await beat(page, 1800);
  const hello = page.getByTestId("lua-console-output").getByText(/Hello/);
  if ((await hello.count().catch(() => 0)) === 0) {
    await clickIfTestId(page, "editor-run-in-dcs");
  }
  await hello.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await beat(page, 1500);
  await shot(page, "hello-console");

  // 6) REPL against the LIVE sim (hook env: DCS.*, lfs.*).
  await openTool(page, "repl");
  await runRepl(page, "return DCS.getModelTime()");
  await shot(page, "repl-modeltime");
  await runRepl(page, "return lfs.writedir()");
  await shot(page, "repl-writedir");

  // 7) DCS Log viewer — the mod's "teaser-mod" line, highlighted + isolated.
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

/** Click an element by test id if present; returns whether it fired. */
async function clickIfTestId(page: Page, id: string): Promise<boolean> {
  const el = page.getByTestId(id).first();
  if (await el.count()) {
    await el.click().catch(() => {});
    return true;
  }
  return false;
}
