// E2E: the Structure panel — the active file's symbol outline from the
// embedded wasm engine, in a plain browser: no Tauri, no DCS
// (model/studio/lang.pds ClickSymbolNavigatesEditor).

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
});
