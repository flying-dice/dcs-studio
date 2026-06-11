// E2E: the Structure panel — the active file's symbol outline from the
// embedded wasm engine, in a plain browser: no Tauri, no DCS
// (model/studio/lang.pds ClickSymbolNavigatesEditor and
// OutlineNeverGoesStale).

import { test, expect, type Page } from "@playwright/test";

// Must match /lab/structure's seeded document.
const INITIAL = `-- наводка °
local top = 1

function outer()
  local inner = function() end
  return inner
end

function helper() end
`;

async function setEditorText(page: Page, code: string): Promise<void> {
  // `.fill` on the contenteditable replaces wholesale (problems.spec).
  const content = page.getByTestId("lab-editor").locator(".cm-content");
  await content.click();
  await content.fill(code);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/structure");
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "editor ready",
    { timeout: 30_000 },
  );
});

test("outline lists the file's nested function tree", async ({ page }) => {
  const entries = page.getByTestId("structure-entry");
  // The lint pump's initial pass populates the outline.
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });
  // `inner` is nested under `outer`: one tree level deeper than its parent.
  await expect(entries.nth(1)).toHaveCSS("padding-left", "6px");
  await expect(entries.nth(2)).toHaveCSS("padding-left", "20px");
  // Kinds are told apart by icon: `top` is a variable (sky),
  // `outer` a function (purple).
  await expect(entries.nth(0).locator(".text-sky-500")).toBeVisible();
  await expect(entries.nth(1).locator(".text-purple-500")).toBeVisible();
});

test("clicking a symbol navigates the editor to its name", async ({
  page,
}) => {
  const inner = page
    .getByTestId("structure-entry")
    .filter({ hasText: "inner" });
  await expect(inner).toBeVisible({ timeout: 15_000 });

  await inner.click();

  // The caret lands exactly on the symbol's name — a UTF-16 offset, so
  // this only holds when the engine's byte spans were converted (the
  // multibyte comment shifts every byte offset past every UTF-16 one).
  const expected = INITIAL.indexOf("inner");
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${expected}`,
    { timeout: 5_000 },
  );

  // …and the selection follows the cursor: the clicked row highlights.
  await expect(inner).toHaveAttribute("data-active", "true");

  // Navigation hands focus to the editor so typing continues there.
  await expect(
    page.getByTestId("lab-editor").locator(".cm-content"),
  ).toBeFocused();
});

test("an edit updates the outline after the debounce", async ({ page }) => {
  await expect(
    page.getByTestId("structure-entry").filter({ hasText: "helper" }),
  ).toBeVisible({ timeout: 15_000 });

  await setEditorText(
    page,
    INITIAL + "function added() end\n",
  );

  await expect(
    page.getByTestId("structure-entry").filter({ hasText: "added" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("a file no provider claims shows the no-structure notice", async ({
  page,
}) => {
  await page.getByTestId("switch-file").click();
  await expect(page.getByTestId("structure-panel")).toContainText(
    "No structure for this file type",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("structure-entry")).toHaveCount(0);
  // An unclaimed file is a routing outcome, not an engine failure: the
  // no-provider guard answers it before any engine is asked.
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "engine: ready",
  );
});

test("an empty Lua file shows the no-symbols notice", async ({ page }) => {
  await expect(
    page.getByTestId("structure-entry").filter({ hasText: "helper" }),
  ).toBeVisible({ timeout: 15_000 });

  // A claimed file with zero declarations is "No symbols" — never the
  // unclaimed-file-type notice (model RefreshOutline's empty states).
  await setEditorText(page, "-- nothing declared yet\n");

  await expect(page.getByTestId("structure-panel")).toContainText(
    "No symbols",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("structure-entry")).toHaveCount(0);
});

test("no open file shows the no-file notice", async ({ page }) => {
  await page.getByTestId("close-file").click();
  await expect(page.getByTestId("structure-panel")).toContainText(
    "No file open",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("structure-entry")).toHaveCount(0);
  // No file open is the no-path guard's arm, never an engine failure.
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "engine: ready",
  );
});

test("switching files never shows the previous file's outline", async ({
  page,
}) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });

  await page.getByTestId("switch-lua").click();

  // One-shot read (no retry): whatever rows are visible right now must
  // belong to the active file — the previous file's symbols clear
  // synchronously on the switch, before the async outline query for the
  // new file resolves. Without that clear, a stale row clicked here would
  // navigate the editor to the old file's offsets.
  const visible = (await entries.allTextContents()).map((t) => t.trim());
  for (const stale of ["top", "outer", "inner", "helper"]) {
    expect(visible).not.toContain(stale);
  }

  // …and the new file's outline arrives.
  await expect(entries).toHaveText(["alpha"], { timeout: 15_000 });
});

test("a symbol entry activates from the keyboard", async ({ page }) => {
  const helper = page
    .getByTestId("structure-entry")
    .filter({ hasText: "helper" });
  await expect(helper).toBeVisible({ timeout: 15_000 });

  await helper.press("Enter");

  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${INITIAL.indexOf("helper")}`,
    { timeout: 5_000 },
  );
});

test("the caret highlight honours the span boundaries", async ({ page }) => {
  const top = page.getByTestId("structure-entry").filter({ hasText: "top" });
  await expect(top).toBeVisible({ timeout: 15_000 });

  // Caret on the name: inside the span, row highlighted.
  await top.click();
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${INITIAL.indexOf("top")}`,
    { timeout: 5_000 },
  );
  await expect(top).toHaveAttribute("data-active", "true");

  // End of the declaration line is the statement span's EXCLUSIVE end —
  // the caret there encloses nothing.
  await page.keyboard.press("End");
  const lineEnd = INITIAL.indexOf("local top = 1") + "local top = 1".length;
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${lineEnd}`,
    { timeout: 5_000 },
  );
  await expect(top).toHaveAttribute("data-active", "false");

  // …while the span's start is inclusive.
  await page.keyboard.press("Home");
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${INITIAL.indexOf("local top = 1")}`,
    { timeout: 5_000 },
  );
  await expect(top).toHaveAttribute("data-active", "true");
});

test("a caret in another file never highlights the outline", async ({
  page,
}) => {
  // Park the LUA caret on `top` (offset 19 — inside alpha's 0..20 span,
  // so only the cursor-path check keeps the highlight off).
  const top = page.getByTestId("structure-entry").filter({ hasText: "top" });
  await expect(top).toBeVisible({ timeout: 15_000 });
  await top.click();
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${INITIAL.indexOf("top")}`,
    { timeout: 5_000 },
  );

  await page.getByTestId("switch-lua").click();
  const alpha = page
    .getByTestId("structure-entry")
    .filter({ hasText: "alpha" });
  await expect(alpha).toBeVisible({ timeout: 15_000 });

  await expect(alpha).toHaveAttribute("data-active", "false");
});

test("editing a file the panel does not outline leaves the outline alone", async ({
  page,
}) => {
  await page.getByTestId("switch-file").click();
  const panel = page.getByTestId("structure-panel");
  await expect(panel).toContainText("No structure for this file type", {
    timeout: 15_000,
  });

  // The Lua editor stays open while the panel outlines notes.txt; its
  // edit pump must not re-point the outline at the edited file.
  await setEditorText(page, INITIAL + "function added() end\n");
  await page.waitForTimeout(2_000); // lint debounce ~750ms, then settle

  expect(await page.getByTestId("structure-entry").count()).toBe(0);
  await expect(page.getByTestId("outline-path")).toHaveText(
    "outline-of: lab/notes.txt",
  );
  await expect(panel).toContainText("No structure for this file type");
});

test("clicking a symbol with no live editor is a graceful no-op", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  // other.lua's outline shows, but no editor holds the file.
  await page.getByTestId("switch-lua").click();
  const alpha = page
    .getByTestId("structure-entry")
    .filter({ hasText: "alpha" });
  await expect(alpha).toBeVisible({ timeout: 15_000 });

  await alpha.click();
  await page.waitForTimeout(300);

  expect(errors).toEqual([]);
  await expect(alpha).toBeVisible();
});

test("a superseded outline response is discarded", async ({ page }) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });

  // main.lua outline queries now take 600ms; other.lua stays instant.
  await page.getByTestId("outline-slow").click();
  await page.getByTestId("switch-lua").click();
  await expect(entries).toHaveText(["alpha"], { timeout: 15_000 });

  // Switch to main.lua (slow query in flight) and immediately back: the
  // slow response now belongs to a superseded query.
  await page.getByTestId("switch-lua").click();
  await page.getByTestId("switch-lua").click();
  await expect(entries).toHaveText(["alpha"], { timeout: 15_000 });

  // After the slow response has landed, it must have been discarded.
  await page.waitForTimeout(1_200);
  const visible = (await entries.allTextContents()).map((t) => t.trim());
  expect(visible).toEqual(["alpha"]);
});

test("an outline engine failure marks the engine failed and empties the panel", async ({
  page,
}) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });

  await page.getByTestId("outline-fail").click();
  // Re-enter RefreshOutline through the edit pump (same file).
  await setEditorText(page, INITIAL + "-- touch\n");

  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "engine: failed",
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("structure-panel")).toContainText(
    "No symbols",
  );
  await expect(entries).toHaveCount(0);
});

test("a late failure for a superseded file keeps the current outline", async ({
  page,
}) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });

  // main.lua outline queries now reject after 600ms.
  await page.getByTestId("outline-fail-slow").click();
  await page.getByTestId("switch-lua").click();
  await expect(entries).toHaveText(["alpha"], { timeout: 15_000 });

  await page.getByTestId("switch-lua").click();
  await page.getByTestId("switch-lua").click();
  await expect(entries).toHaveText(["alpha"], { timeout: 15_000 });

  // The late rejection belongs to a superseded query: it must not blank
  // the outline the panel currently shows.
  await page.waitForTimeout(1_200);
  const visible = (await entries.allTextContents()).map((t) => t.trim());
  expect(visible).toEqual(["alpha"]);
});

test("hiding the panel clears the outline", async ({ page }) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });
  await expect(page.getByTestId("outline-path")).toHaveText(
    "outline-of: lab/main.lua",
  );

  // Unmounting runs the $effect cleanup: a hidden panel must not keep the
  // outline store live (every lint pass would re-query invisibly).
  await page.getByTestId("toggle-panel").click();
  await expect(page.getByTestId("structure-panel")).toHaveCount(0);
  await expect(page.getByTestId("outline-path")).toHaveText("outline-of: -");

  // Re-showing re-outlines the active file.
  await page.getByTestId("toggle-panel").click();
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });
});

test("navigation scrolls the symbol into view", async ({ page }) => {
  const entries = page.getByTestId("structure-entry");
  await expect(entries).toHaveText(["top", "outer", "inner", "helper"], {
    timeout: 15_000,
  });

  const LONG = INITIAL + "-- pad\n".repeat(200) + "function tail() end\n";
  await setEditorText(page, LONG);
  const tail = entries.filter({ hasText: "tail" });
  await expect(tail).toBeVisible({ timeout: 15_000 });

  // Park the view at the top of the document…
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  const scroller = page.getByTestId("lab-editor").locator(".cm-scroller");
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeLessThan(5);

  // …then navigate to the last symbol: the caret lands on its name AND
  // the editor scrolls it into view.
  await tail.click();
  await expect(page.getByTestId("cursor-offset")).toHaveText(
    `cursor: ${LONG.indexOf("tail")}`,
    { timeout: 5_000 },
  );
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(100);
});
