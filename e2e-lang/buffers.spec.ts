// E2E: per-open-file editor buffers (issue #21). Each tab owns its own
// EditorState — doc, undo history, selection — so undo in one file can never
// resurrect another file's content, and unsaved edits survive tab switches.
// Runs in a plain browser against /lab/buffers: no Tauri, no DCS
// (model/studio/core.pds UndoNeverCrossesFiles, TabSwitchKeepsUnsavedEdits,
// CloseDirtyTabPrompts).

import { test, expect, type Page } from "@playwright/test";

const editor = (page: Page) =>
  page.getByTestId("lab-editor").locator(".cm-content");
const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/buffers");
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("undo after opening a second file never resurrects the first file's content", async ({
  page,
}) => {
  // The exact issue-#21 corruption sequence: open a.lua, open b.lua, Ctrl-Z.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');

  await editor(page).click();
  await page.keyboard.press("Control+z");

  // The buffer must still show b.lua's content — never a.lua's…
  await expect(editor(page)).toContainText('print("world")');
  await expect(editor(page)).not.toContainText("hello");
  // …and b.lua must not be dirty (a dirty flag here meant Ctrl-S would
  // overwrite b.lua on disk with a.lua's stale buffer).
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");
});

test("tab switch round-trip preserves an unsaved edit and its undo stack", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');

  // One undoable edit in a.lua (`.fill` replaces wholesale, one transaction).
  await editor(page).click();
  await editor(page).fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  // A → B → A.
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  // b.lua is its own clean buffer; a.lua's tab still flags the pending edit.
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
  await tab(page, "lab/a.lua").click();

  // The pending edit survived the round trip…
  await expect(editor(page)).toContainText('print("edited")');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  // …and undo still steps back through a.lua's own history to the loaded
  // text (the switch neither dropped the stack nor became undoable itself).
  await editor(page).click();
  await page.keyboard.press("Control+z");
  await expect(editor(page)).toContainText('print("hello")');
  await expect(editor(page)).not.toContainText("edited");
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
});

test("closing a dirty tab prompts; declining keeps the buffer", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  // Declining the confirm keeps the tab and its edits.
  let prompted = false;
  page.once("dialog", (dialog) => {
    prompted = true;
    void dialog.dismiss();
  });
  await page.getByTestId("tab-close").click();
  await expect(tab(page, "lab/a.lua")).toBeVisible();
  await expect(editor(page)).toContainText('print("edited")');
  expect(prompted).toBe(true);

  // Accepting discards the edits and closes the last tab.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId("tab-close").click();
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
});
