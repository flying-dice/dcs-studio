// E2E: the editor-function keymap — line ops (issue #18), driving the real app over CDP:
// no engine (keymap only). Reads the document back after driving keystrokes; toggle
// comment, move line, and duplicate line need no syntax tree, so the assertions
// are exact.
//
// These specs guard `editorCommands` specifically — not basicSetup's identical
// defaults. /lab/editor installs a default-precedence decoy that swallows these
// keys with a no-op, so only `editorCommands` (Prec.high) makes the ops fire.
// Delete `editorCommands` and every spec below goes red — that is the guarantee
// (mutation-verified). See the decoy in src/routes/lab/editor/+page.svelte.
//
// Expand selection is deliberately absent: it needs a Lezer Lua grammar (the
// StreamLanguage tree is token-flat, so selectParentSyntax dead-ends) — see
// src/lib/editor/commands.ts and docs/keybindings.md.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

// Must match /lab/editor's seeded document.
const INITIAL = "local a = 1\nlocal b = 2\nlocal c = 3\n";

/** The editor's current text, read exactly (newlines preserved). */
async function doc(page: Page): Promise<string> {
  return (await page.getByTestId("doc-text").textContent()) ?? "";
}

/** Focus the editor and park the caret at the document start. */
async function caretToStart(page: Page): Promise<void> {
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("editor"));
  await expect(page.getByTestId("lab-ready")).toHaveText("editor ready");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});

test("Alt-Down / Alt-Up moves the current line", async ({ page }) => {
  await caretToStart(page);

  await page.keyboard.press("Alt+ArrowDown");
  await expect
    .poll(() => doc(page))
    .toBe("local b = 2\nlocal a = 1\nlocal c = 3\n");

  // …and back: the move is its own inverse.
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});

test("Shift-Alt-Down duplicates the current line", async ({ page }) => {
  await caretToStart(page);

  await page.keyboard.press("Shift+Alt+ArrowDown");
  await expect
    .poll(() => doc(page))
    .toBe("local a = 1\nlocal a = 1\nlocal b = 2\nlocal c = 3\n");
});

test("Mod-/ toggles a line comment and round-trips", async ({ page }) => {
  await caretToStart(page);

  await page.keyboard.press("Control+/");
  // Lua's comment marker is `--`; the exact margin is the command's business,
  // so assert the marker landed and the line changed, not the spacing.
  const commented = await doc(page);
  expect(commented.split("\n")[0]).toMatch(/^--/);
  expect(commented).not.toBe(INITIAL);
  expect(commented.split("\n")[1]).toBe("local b = 2");

  // Toggling again uncomments — a perfect inverse restores the document.
  await page.keyboard.press("Control+/");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});

test("Mod-/ comments every line a selection spans", async ({ page }) => {
  await caretToStart(page);
  // Select line 1 in full plus line 2 in full; leave line 3 untouched.
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");

  await page.keyboard.press("Control+/");
  const lines = (await doc(page)).split("\n");
  expect(lines[0]).toMatch(/^--/);
  expect(lines[1]).toMatch(/^--/);
  expect(lines[2]).toBe("local c = 3");

  await page.keyboard.press("Control+/");
  await expect.poll(() => doc(page)).toBe(INITIAL);
});
