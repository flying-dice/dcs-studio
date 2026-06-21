// The dcs-studio teaser speedrun — starts on the LANDING PAGE and CREATES a new
// lua-script project (the location defaults to ~/DCSStudio, so no folder picking),
// then drives the IDE against the developer's live DCS. The WINDOW is captured by
// ffmpeg at 1920x1080 (scripts/teaser-record.mjs). Paced + LENIENT — a beat that
// can't reach a panel/the live sim is skipped, never failing the whole take.
//
//   node scripts/teaser-record.mjs   (needs DCS + the bridge up)
import { test, expect } from "../e2e-lang/_tauri";
import type { Page } from "@playwright/test";
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const BASE = "http://localhost:1420";
const NAME = "teaser-mod";
const DEST = join(homedir(), "DCSStudio", NAME);
const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

let shotN = 0;
const shot = (page: Page, name: string) =>
  page
    .screenshot({ path: `teaser-results/${String(++shotN).padStart(2, "0")}-${name}.png` })
    .catch(() => {});

async function openTool(page: Page, id: string): Promise<void> {
  await page.getByTestId(`tool-${id}`).first().click().catch(() => {});
  await beat(page, 1000);
}

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
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(code, { delay: 45 });
  await beat(page, 600);
  await page.getByTestId("lua-console-run").click();
  await beat(page, 1800);
}

test("dcs-studio speedrun", async ({ page }) => {
  test.setTimeout(300_000);
  rmSync(DEST, { recursive: true, force: true }); // remove a prior run's project
  // Clear any restored session + the location cache so it defaults to ~/DCSStudio.
  await page.addInitScript(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  await page.goto(`${BASE}/`);

  // 1) Landing page → New Project.
  const newProject = page.getByRole("button", { name: /New Project/ }).first();
  await expect(newProject).toBeVisible({ timeout: 90_000 });
  await beat(page, 1600);
  await shot(page, "landing");
  await newProject.click();
  await beat(page, 1000);

  // 2) Lua Script template + name; the location is pre-filled (~/DCSStudio), so
  //    Create is enabled without any folder picking.
  await page.getByRole("button", { name: /Lua Script/ }).first().click().catch(() => {});
  await beat(page, 800);
  await page.getByPlaceholder("my-script-mod").click();
  await page.keyboard.type(NAME, { delay: 60 });
  await beat(page, 1000);
  await shot(page, "new-project");
  // Submit via the name input's Enter handler (calls create()) — avoids the
  // Create button's actionability/animation flake. Force-click as a fallback.
  await page.keyboard.press("Enter");
  await beat(page, 1800);
  if ((await page.getByRole("button", { name: "dcs-studio.toml" }).count()) === 0) {
    await page
      .getByRole("button", { name: /Create Project/ })
      .first()
      .click({ force: true })
      .catch(() => {});
  }
  await beat(page, 1200);

  // 3) The new project opens — wait for its file tree.
  await expect(page.getByRole("button", { name: "dcs-studio.toml" })).toBeVisible({ timeout: 60_000 });
  await beat(page, 1500);
  await shot(page, "created");

  // 4) Open the scaffolded entry script (Scripts/teaser-mod/main.lua).
  await page.getByRole("button", { name: "Scripts" }).first().click().catch(() => {});
  await beat(page, 700);
  await page.getByRole("button", { name: NAME }).first().click().catch(() => {});
  await beat(page, 700);
  await page.getByRole("button", { name: "main.lua" }).first().click().catch(() => {});
  await beat(page, 1500);
  await shot(page, "script");

  // 5) Install the bridge + launch DCS if it isn't already connected.
  await openTool(page, "inject");
  await clickIf(page, /^(Inject|Update|Reinstall)/);
  await beat(page, 2000);
  const link = () => page.getByText(/DCS:\s*connected|mission running/i).first();
  if (!(await link().isVisible().catch(() => false))) {
    await clickIf(page, /Launch DCS/i);
    await shot(page, "launching");
    await link().waitFor({ state: "visible", timeout: 240_000 }).catch(() => {});
  }
  await beat(page, 2500);
  await shot(page, "dcs-live");

  // 6) REPL against the LIVE sim (hook env: DCS.*, lfs.*).
  await openTool(page, "repl");
  await runRepl(page, "return DCS.getModelTime()");
  await shot(page, "repl-modeltime");
  await runRepl(page, "return lfs.writedir()");
  await shot(page, "repl-writedir");

  // 7) Mission scripting + DCS Log viewer.
  await openTool(page, "mission");
  await clickIf(page, /Desanitize all/i);
  await beat(page, 1200);
  await shot(page, "desanitized");
  await openTool(page, "dcslog");
  await beat(page, 1800);
  await shot(page, "dcs-log");
});
