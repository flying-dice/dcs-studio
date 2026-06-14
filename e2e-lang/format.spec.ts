// E2E: Format Document / Selection + format-on-save (issue #18, model
// studio::edit::Formatting), in a plain browser. The real formatter runs in
// Rust behind the `format_source` Tauri command — unreachable here — so
// /lab/editor injects a deterministic stub Formatter (collapses runs of spaces;
// records the range it was handed). These specs guard the editor WIRING:
// Shift-Alt-F fires, computes the right range (whole document vs the
// selection), converts editor offsets to the engine's bytes, and applies the
// result; and ⌘S routes through the shared save-with-format orchestrator. The
// engine's real formatting and range-scoping are proven in Rust
// (crates/app/src/format.rs).
//
// Shift-Alt-F is not a basicSetup default, so deleting `formatKeymap` (or its
// facet) makes the key inert and every spec below goes red — that is the
// guarantee. No decoy is needed (unlike the line-ops specs, whose keys collide
// with basicSetup defaults). Mod-s is likewise not a basicSetup default, so the
// lab's save binding owns it: drop `saveWithFormat` (or the binding) and the
// format-on-save specs go red.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

/** The editor's current text, read exactly (newlines preserved). */
async function doc(page: Page): Promise<string> {
  return (await page.getByTestId("doc-text").textContent()) ?? "";
}

/** The range the stub formatter was last handed: "doc", or "from,to". */
async function formatRange(page: Page): Promise<string> {
  return ((await page.getByTestId("format-range").textContent()) ?? "").trim();
}

/** The text the lab's save path last persisted (whole-buffer, newlines kept). */
async function persisted(page: Page): Promise<string> {
  return (await page.getByTestId("persisted-text").textContent()) ?? "";
}

/** Replace the whole buffer with `text` (the lab seeds canonical Lua). */
async function selectAllAndType(page: Page, text: string): Promise<void> {
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("editor"));
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

test("Format Selection maps the selection to engine BYTE offsets, not UTF-16", async ({
  page,
}) => {
  // 'é' is one UTF-16 code unit but two UTF-8 bytes. The engine's Span is bytes
  // (offsets.ts, span.rs), so a selection running to the end of `é = 1` must
  // arrive as byte 6, not UTF-16 unit 5 — the offset bug records the latter.
  await selectAllAndType(page, "é = 1");
  await expect.poll(() => doc(page)).toBe("é = 1");

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Shift+Alt+F");

  await expect.poll(() => formatRange(page)).toBe("0,6");
});

test("format-on-save persists the reformatted buffer before the write", async ({
  page,
}) => {
  await page.getByTestId("toggle-format-on-save").click();
  await selectAllAndType(page, "local   x  =  1");
  await expect.poll(() => doc(page)).toBe("local   x  =  1");

  await page.keyboard.press("Control+s");

  // The buffer is reformatted (the stub collapses runs of spaces) BEFORE the
  // write, so disk gets the formatted text — and exactly one write happens.
  await expect.poll(() => persisted(page)).toBe("local x = 1");
  await expect.poll(() => doc(page)).toBe("local x = 1");
  await expect(page.getByTestId("persist-count")).toHaveText("1");
});

test("format-on-save never blocks the save when the buffer will not format", async ({
  page,
}) => {
  await page.getByTestId("toggle-format-on-save").click();
  await page.getByTestId("toggle-formatter-throws").click();
  await selectAllAndType(page, "local   x  =  1");

  await page.keyboard.press("Control+s");

  // The formatter threw (unparseable buffer): the ORIGINAL text is persisted
  // unchanged and the save still happened (model SaveNeverBlockedByBrokenLua).
  await expect.poll(() => persisted(page)).toBe("local   x  =  1");
  await expect(page.getByTestId("persist-count")).toHaveText("1");
});

test("a plain save (format-on-save off) persists the buffer verbatim", async ({
  page,
}) => {
  // format-on-save defaults off.
  await selectAllAndType(page, "local   x  =  1");

  await page.keyboard.press("Control+s");

  await expect.poll(() => persisted(page)).toBe("local   x  =  1");
  // The formatter was never consulted.
  await expect.poll(() => formatRange(page)).toBe("-");
  await expect(page.getByTestId("persist-count")).toHaveText("1");
});
