// E2E: in-file find/replace (issue #73) — the editor's owned CodeMirror search,
// driving the real app over CDP. Mirrors editor-line-ops: /lab/editor installs a
// default-precedence decoy (searchKeymapShadow) that swallows Mod-f, so these
// specs fire only because `searchExtensions` (Prec.high) owns the key — delete it
// and every spec below goes red (mutation-verified), proving they guard the owned
// wiring rather than basicSetup's identical default searchKeymap. The panel docks
// at the top (`search({ top: true })`), the other observable mark of the owned
// wiring.
//
// The webview's native-find suppression (the global Ctrl+F preventDefault) lives
// in the production route (src/routes/+page.svelte), not this lab harness, so it
// is out of this suite's scope — exercised by hand / review like the other global
// shortcuts (⌘S, ⌘N).

import { test, expect, labUrl } from "./_tauri";
import type { Page, Locator } from "@playwright/test";

// Must match /lab/editor's seeded document.
const INITIAL = "local a = 1\nlocal b = 2\nlocal c = 3\n";

/** The editor's current text, read exactly (newlines preserved). */
async function doc(page: Page): Promise<string> {
  return (await page.getByTestId("doc-text").textContent()) ?? "";
}

/** The search panel, scoped to the lab editor. */
function panel(page: Page): Locator {
  return page.getByTestId("lab-editor").locator(".cm-search");
}

/** Focus the editor so its keymap — not the page — receives the keystrokes. */
async function focusEditor(page: Page): Promise<void> {
  await page.getByTestId("lab-editor").locator(".cm-content").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("editor"));
  await expect(page.getByTestId("lab-ready")).toHaveText("editor ready");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});

test("Ctrl+F opens the find panel at the top with the query field focused", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.press("Control+f");

  await expect(panel(page)).toBeVisible();
  // Top-docked — the observable mark of search({ top: true }), versus
  // basicSetup's default bottom panel.
  await expect(
    page.getByTestId("lab-editor").locator(".cm-panels-top .cm-search"),
  ).toBeVisible();
  // Query field focused, ready to type.
  await expect(panel(page).locator("input[name='search']")).toBeFocused();
});

test("Replace All rewrites every match in one undo step", async ({ page }) => {
  await focusEditor(page);
  await page.keyboard.press("Control+f");

  await panel(page).locator("input[name='search']").fill("local");
  await panel(page).locator("input[name='replace']").fill("const");
  await panel(page).locator("button[name='replaceAll']").click();

  await expect
    .poll(() => doc(page))
    .toBe("const a = 1\nconst b = 2\nconst c = 3\n");

  // One undo restores the whole document — Replace All is a single history step.
  await focusEditor(page);
  await page.keyboard.press("Control+z");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});

test("Escape closes the panel and returns focus to the document", async ({
  page,
}) => {
  await focusEditor(page);
  await page.keyboard.press("Control+f");
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();

  // Focus is back on the document: typing lands in the buffer, not a dead panel.
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("x");
  await expect.poll(() => doc(page)).toBe("x" + INITIAL);
});
