// E2E: Format Document / Selection (issue #18, model studio::edit::Formatting),
// in a plain browser. The real formatter runs in Rust behind the
// `format_source` Tauri command — unreachable here — so /lab/editor injects a
// deterministic stub Formatter (collapses runs of spaces; records the range it
// was handed). These specs guard the editor WIRING: Shift-Alt-F fires, computes
// the right range (whole document vs the selection), and applies the result.
// The engine's real formatting and range-scoping are proven in Rust
// (crates/app/src/format.rs).
//
// Shift-Alt-F is not a basicSetup default, so deleting `formatKeymap` (or its
// facet) makes the key inert and every spec below goes red — that is the
// guarantee. No decoy is needed (unlike the line-ops specs, whose keys collide
// with basicSetup defaults).

import { test, expect, type Page } from "@playwright/test";

/** The editor's current text, read exactly (newlines preserved). */
async function doc(page: Page): Promise<string> {
  return (await page.getByTestId("doc-text").textContent()) ?? "";
}

/** The range the stub formatter was last handed: "doc", or "from,to". */
async function formatRange(page: Page): Promise<string> {
  return ((await page.getByTestId("format-range").textContent()) ?? "").trim();
}

/** Replace the whole buffer with `text` (the lab seeds canonical Lua). */
async function selectAllAndType(page: Page, text: string): Promise<void> {
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/editor");
  await expect(page.getByTestId("lab-ready")).toHaveText("editor ready");
});

test("Shift-Alt-F formats the whole document when nothing is selected", async ({
  page,
}) => {
  await selectAllAndType(page, "local   x  =  1");
  await expect.poll(() => doc(page)).toBe("local   x  =  1");

  await page.keyboard.press("Shift+Alt+F");

  // The stub collapses runs of spaces; the whole document was reformatted and
  // the formatter was handed no range.
  await expect.poll(() => doc(page)).toBe("local x = 1");
  await expect.poll(() => formatRange(page)).toBe("doc");
});

test("Shift-Alt-F formats just the selection when one is non-empty", async ({
  page,
}) => {
  await selectAllAndType(page, "local   a  =  1");
  // Caret home, then extend to the line end: a non-empty selection.
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");

  await page.keyboard.press("Shift+Alt+F");

  // The command passed the selection's byte range (from the line start), not a
  // whole-document format ("doc").
  await expect.poll(() => formatRange(page)).toMatch(/^0,\d+$/);
});
