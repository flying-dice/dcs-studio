// E2E: per-open-file editor buffers (issue #21). Each tab owns its own
// EditorState — doc, undo history, selection — so undo in one file can never
// resurrect another file's content, and unsaved edits survive tab switches.
// Runs in a plain browser against /lab/buffers: no Tauri, no DCS
// (model/studio/core.pds UndoNeverCrossesFiles, TabSwitchKeepsUnsavedEdits,
// CloseActiveTabActivatesNeighbour, RetriggeredLoadDiscardsStaleRead,
// CloseDirtyTabPrompts).

import { test, expect, labUrl, armConfirm, confirmPrompts } from "./_tauri";
import type { Page } from "@playwright/test";

const editor = (page: Page) =>
  page.getByTestId("lab-editor").locator(".cm-content");
const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("buffers"));
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

test("a stale in-flight read never hijacks the view after switching back", async ({
  page,
}) => {
  // Race regression (pre-push review F1): A shown -> activate B (its first
  // read still in flight) -> activate A again -> B's read lands. The stale
  // read must be discarded, never shown. The lab's hold/release seam makes
  // the in-flight window deterministic (model StaleLoadNeverHijacksView).
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');

  await page.getByTestId("hold-next-b").click();
  await page.getByTestId("open-b").click();
  // release-b arms only once b.lua's read is genuinely parked in flight.
  await expect(page.getByTestId("release-b")).toBeEnabled();

  // Switch back to A while B's read is in flight, then let it land.
  await tab(page, "lab/a.lua").click();
  await page.getByTestId("release-b").click();
  await expect(page.getByTestId("release-b")).toBeDisabled();

  // The view still shows A — the tab strip and the buffer agree.
  await expect(editor(page)).toContainText('print("hello")');
  await expect(editor(page)).not.toContainText("world");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");

  // Edits route into A's buffer, never B's.
  await editor(page).click();
  await editor(page).fill('print("routed to a")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");

  // B still loads cleanly on a real activation afterwards.
  await tab(page, "lab/b.lua").click();
  await expect(editor(page)).toContainText('print("world")');
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");
});

test("closing the active tab activates its neighbour and shows its buffer", async ({
  page,
}) => {
  // model CloseActiveTabActivatesNeighbour: a + b open, b active; closing b
  // via its × must hand the view to a — tab strip and buffer agreeing.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-active", "true");

  await tab(page, "lab/b.lua").getByTestId("tab-close").click();

  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");
  await expect(editor(page)).toContainText('print("hello")');
  await expect(editor(page)).not.toContainText("world");
});

test("closing a non-active tab never steals focus from the active one", async ({
  page,
}) => {
  // model CloseActiveTabActivatesNeighbour (non-active arm). Three tabs, not
  // two: with only a + b, a's neighbour IS the active b, so "no steal" and
  // "steal-to-neighbour" are indistinguishable and the spec can't fail. With
  // c active, a buggy steal would hand focus to a's neighbour b — not c.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await page.getByTestId("open-c").click();
  await expect(editor(page)).toContainText('print("third")');
  await expect(tab(page, "lab/c.lua")).toHaveAttribute("data-active", "true");

  // A pending edit in the active tab: the close must not disturb it. This
  // discriminates the same-path early return in the swap effect — without
  // it, the tab-list change re-runs the load and wipes the shown buffer
  // back to the on-disk text.
  await editor(page).click();
  await editor(page).fill('print("edited c")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await tab(page, "lab/a.lua").getByTestId("tab-close").click();

  await expect(tab(page, "lab/a.lua")).toHaveCount(0);
  // c stays active — focus must not jump to a's neighbour b.
  await expect(tab(page, "lab/c.lua")).toHaveAttribute("data-active", "true");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-active", "false");
  // …and c's pending edit and dirty flag survived the unrelated close.
  await expect(editor(page)).toContainText('print("edited c")');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await expect(tab(page, "lab/c.lua")).toHaveAttribute("data-dirty", "true");
  await expect(editor(page)).not.toContainText("hello");
  await expect(editor(page)).not.toContainText("world");
});

test("File → Close Editor closes the active tab and falls back to the neighbour", async ({
  page,
}) => {
  // closeActiveFile (the menu path) must behave exactly like the active
  // tab's ×: neighbour activation first, then the no-file-open state.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');

  await page.getByTestId("close-active").click();
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");
  await expect(editor(page)).toContainText('print("hello")');

  // Closing the last tab returns to the no-file-open state. Prod
  // (`routes/+page.svelte`) gates the Editor behind an open file, so the last
  // close unmounts it and shows the no-file placeholder (model
  // ClosingLastTabShowsPlaceholder). The previous file's text must not linger:
  // the editor is gone entirely, not merely blanked.
  await page.getByTestId("close-active").click();
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  await expect(page.getByTestId("no-file-placeholder")).toBeVisible();
  await expect(
    page.getByTestId("lab-editor").locator(".cm-content"),
  ).toHaveCount(0);
});

test("re-activating a file discards its own stale first read", async ({
  page,
}) => {
  // The loadSeq bump's independent job (model RetriggeredLoadDiscardsStaleRead):
  // A shown -> open B (first read held in flight) -> back to A -> open B again
  // (re-triggered read lands at once) -> release the FIRST read. The stale
  // read targets the tab that IS active, so only the per-run sequence bump
  // can disarm it — were it to land, it would wipe B's re-triggered buffer.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');

  await page.getByTestId("hold-next-b").click();
  await page.getByTestId("open-b").click();
  await expect(page.getByTestId("release-b")).toBeEnabled();

  // Back to A while B's first read is parked, then re-activate B: the
  // re-triggered (unheld) read lands immediately and wins the view.
  await tab(page, "lab/a.lua").click();
  await tab(page, "lab/b.lua").click();
  await expect(editor(page)).toContainText('print("world")');

  // Distinguish the second load from the stale first read (both carry the
  // same disk text): an unsaved edit on top of the second load.
  await editor(page).click();
  await editor(page).fill('print("edited b")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  // Let the stale first read finally resolve — it must be discarded, not
  // swap in a pristine buffer over the edit (and clear the dirty flag).
  await page.getByTestId("release-b").click();
  await expect(page.getByTestId("release-b")).toBeDisabled();
  await expect(editor(page)).toContainText('print("edited b")');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "true");

  // A's buffer is untouched.
  await tab(page, "lab/a.lua").click();
  await expect(editor(page)).toContainText('print("hello")');
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "false");
});

test("closing a dirty tab prompts; declining keeps the buffer", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  // Declining the confirm keeps the tab and its edits. The prompt names
  // the file (issue #25 moved the message to the closeFile call site —
  // the per-file form must not regress into the project-switch count form).
  await armConfirm(page, /* accept */ false);
  await page.getByTestId("tab-close").click();
  await expect(tab(page, "lab/a.lua")).toBeVisible();
  await expect(editor(page)).toContainText('print("edited")');
  const prompts = await confirmPrompts(page);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.join("\n")).toContain(
    "a.lua has unsaved changes. Close it and discard them?",
  );

  // Accepting discards the edits and closes the last tab.
  await armConfirm(page, /* accept */ true);
  await page.getByTestId("tab-close").click();
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
});

test("declining a dirty non-active tab's close leaves the active tab focused", async ({
  page,
}) => {
  // Closing is never activating (model CloseDirtyTabPrompts, last clause):
  // the × on a background tab must not hand it focus while — or after —
  // its discard prompt is up. Pins the close button's stopPropagation.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-active", "true");

  await armConfirm(page, /* accept */ false);
  await tab(page, "lab/a.lua").getByTestId("tab-close").click();

  expect((await confirmPrompts(page)).length).toBeGreaterThan(0);
  // b keeps the view; a keeps its tab, edits, and dirty flag.
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-active", "true");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "false");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(editor(page)).toContainText('print("world")');
});

test("with no confirm surface, closing a dirty tab is denied", async ({
  page,
}) => {
  // model NoConfirmSurfaceNeverDiscards / ConfirmDiscard's deny-by-default
  // arm: when neither the native dialog nor window.confirm exists, the
  // answer is NO — unsaved work is never silently discarded.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await page.evaluate(() => {
    (window as unknown as { confirm: unknown }).confirm = undefined;
  });
  await page.getByTestId("tab-close").click();

  // The tab is still open with its buffer intact.
  await expect(tab(page, "lab/a.lua")).toBeVisible();
  await expect(editor(page)).toContainText('print("edited")');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
});

test("reopening a tab closed while parked reloads from disk", async ({
  page,
}) => {
  // model ReopenAfterCloseReloadsFromDisk: discarded edits stay discarded.
  // This arm pins the parked-state prune — b's dirty buffer was parked by
  // the switch to a, and closing b must drop it, not leave it to be
  // resurrected on reopen.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await editor(page).click();
  await editor(page).fill('print("edited b")\n');
  await tab(page, "lab/a.lua").click();
  await expect(editor(page)).toContainText('print("hello")');
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "true");

  await armConfirm(page, /* accept */ true);
  await tab(page, "lab/b.lua").getByTestId("tab-close").click();
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);

  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await expect(editor(page)).not.toContainText("edited");
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");
});

test("reopening a tab closed while shown reloads from disk", async ({
  page,
}) => {
  // model ReopenAfterCloseReloadsFromDisk, other arm: closing the tab the
  // view is showing must not park its buffer on the way out — pins
  // parkCurrent's still-open guard.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await editor(page).click();
  await editor(page).fill('print("edited b")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await armConfirm(page, /* accept */ true);
  await tab(page, "lab/b.lua").getByTestId("tab-close").click();
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(editor(page)).toContainText('print("hello")');

  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await expect(editor(page)).not.toContainText("edited");
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");
});

test("opening an already-open file again keeps its buffer and never duplicates the tab", async ({
  page,
}) => {
  // model OpeningAnOpenFileKeepsItsBuffer / OpenFile's FindOpen arm: a
  // project-tree click on an open file re-activates the tab as-is.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');

  await page.getByTestId("open-a").click();

  await expect(tab(page, "lab/a.lua")).toHaveCount(1);
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");
  await expect(editor(page)).toContainText('print("edited a")');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
});

test("a failed read closes the tab instead of leaving an empty impostor", async ({
  page,
}) => {
  // model FailedReadClosesTab / LoadTab's Err arm: an empty buffer must
  // never impersonate the file on disk.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');

  await page.getByTestId("open-missing").click();

  await expect(tab(page, "lab/missing.lua")).toHaveCount(0);
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");
  await expect(editor(page)).toContainText('print("hello")');
});

test("switching tabs restores each tab's scroll position", async ({
  page,
}) => {
  // model TabSwitchRestoresScroll: the scroll offset is parked and restored
  // with the buffer.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("line")\n'.repeat(300));

  const scroller = page.getByTestId("lab-editor").locator(".cm-scroller");
  await scroller.evaluate((el) => {
    el.scrollTop = 400;
  });
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);

  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await tab(page, "lab/a.lua").click();
  await expect(editor(page)).toContainText('print("line")');

  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
});

test("save writes the active tab's buffer to its own path and cleans it", async ({
  page,
}) => {
  // model SaveDirtyFile: Ctrl-S persists the active tab's buffer to the
  // active tab's path and the baseline matches the buffer again.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await page.keyboard.press("Control+s");

  await expect(page.getByTestId("lab-writes")).toContainText(
    'lab/a.lua => print("edited")',
  );
  await expect(page.getByTestId("lab-writes")).toContainText("writes: 1");
  await expect(page.getByTestId("lab-status")).toContainText("dirty: false");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "false");
});

test("a keystroke during an in-flight write keeps the tab dirty", async ({
  page,
}) => {
  // model MidSaveKeystrokesKeepTabDirty: the baseline is the text that was
  // written — captured before the write — not the buffer at completion, so
  // edits landing mid-write are never silently blessed as saved.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("first")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await page.getByTestId("hold-next-write").click();
  await editor(page).click();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("release-write")).toBeEnabled();

  // A keystroke lands while the write is parked in flight.
  await page.keyboard.type("-- more");
  await page.getByTestId("release-write").click();
  await expect(page.getByTestId("release-write")).toBeDisabled();

  // The file got the pre-keystroke text, and the tab is still dirty.
  await expect(page.getByTestId("lab-writes")).toContainText(
    'lab/a.lua => print("first")',
  );
  await expect(page.getByTestId("lab-writes")).not.toContainText("more");
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
});

test("a tab switch during an in-flight write still baselines the saved tab", async ({
  page,
}) => {
  // model SaveLandsOnTheSavedTab: the baseline lands on the tab that was
  // saved — never on whichever tab is active when the write finishes.
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("world")');
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("hello")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");

  await page.getByTestId("hold-next-write").click();
  await editor(page).click();
  await page.keyboard.press("Control+s");
  await expect(page.getByTestId("release-write")).toBeEnabled();

  // Switch to b while a's write is parked in flight, then let it land.
  await tab(page, "lab/b.lua").click();
  await expect(editor(page)).toContainText('print("world")');
  await page.getByTestId("release-write").click();
  await expect(page.getByTestId("release-write")).toBeDisabled();

  await expect(page.getByTestId("lab-writes")).toContainText(
    'lab/a.lua => print("edited a")',
  );
  // a is clean — its baseline is the written text…
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "false");
  // …and b was never touched by a's save.
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-dirty", "false");
  await expect(editor(page)).toContainText('print("world")');
});
