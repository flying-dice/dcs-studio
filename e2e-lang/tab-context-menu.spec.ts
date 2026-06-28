// E2E: editor tab right-click context menu (issue #74). The close-family —
// Close Others / Close to the Right / Close All / Close Saved — routes through
// the same dirty-prompt path as the × button, so unsaved work is never
// silently lost; inapplicable items disable. Runs against the real app over
// CDP at /lab/buffers, no DCS (model/studio/core.pds CloseOtherTabs,
// CloseTabsToRight, CloseAllTabs, CloseSavedTabs, TabContextMenuClosesInBulk,
// InapplicableTabMenuItemsDisable).
//
// Copy Path / Copy Relative Path reuse the file tree's clipboard helpers
// ($lib/tree-actions, covered by tree.spec.ts) and the lab opens no project
// root, so they are not re-exercised here.

import { test, expect, labUrl, armConfirm, confirmPrompts } from "./_tauri";
import type { Page } from "@playwright/test";

const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);

/** Open a tab's context menu (right-click) and wait for it to render. */
async function openTabMenu(page: Page, path: string): Promise<void> {
  await tab(page, path).click({ button: "right" });
  await expect(page.getByTestId("tab-context-menu")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("buffers"));
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("Close Others keeps the right-clicked tab and closes the rest", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await page.getByTestId("open-b").click();
  await page.getByTestId("open-c").click();

  await openTabMenu(page, "lab/b.lua");
  await page.getByTestId("ctx-close-others").click();

  await expect(tab(page, "lab/a.lua")).toHaveCount(0);
  await expect(tab(page, "lab/c.lua")).toHaveCount(0);
  await expect(tab(page, "lab/b.lua")).toHaveAttribute("data-active", "true");
});

test("Close to the Right closes only the tabs after the target", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await page.getByTestId("open-b").click();
  await page.getByTestId("open-c").click();

  await openTabMenu(page, "lab/a.lua");
  await page.getByTestId("ctx-close-right").click();

  // a stays; everything to its right is gone.
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-active", "true");
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(tab(page, "lab/c.lua")).toHaveCount(0);
});

test("Close All closes every tab and shows the placeholder", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await page.getByTestId("open-b").click();

  await openTabMenu(page, "lab/a.lua");
  await page.getByTestId("ctx-close-all").click();

  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  await expect(page.getByTestId("no-file-placeholder")).toBeVisible();
});

test("Close Saved closes the unmodified tabs and leaves the dirty one open", async ({
  page,
}) => {
  // a is edited (dirty); b is freshly opened (clean).
  await page.getByTestId("open-a").click();
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.getByTestId("lab-editor").locator(".cm-content").fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await page.getByTestId("open-b").click();

  await openTabMenu(page, "lab/a.lua");
  await page.getByTestId("ctx-close-saved").click();

  // The clean tab closes; the dirty one stays — no prompt, nothing discarded.
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(tab(page, "lab/a.lua")).toBeVisible();
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
  expect((await confirmPrompts(page)).length).toBe(0);
});

test("Close Others prompts for a dirty tab; declining keeps it", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await page.getByTestId("lab-editor").locator(".cm-content").click();
  await page.getByTestId("lab-editor").locator(".cm-content").fill('print("edited")\n');
  await expect(page.getByTestId("lab-status")).toContainText("dirty: true");
  await page.getByTestId("open-b").click();
  await page.getByTestId("open-c").click();

  await armConfirm(page, /* accept */ false);
  await openTabMenu(page, "lab/c.lua");
  await page.getByTestId("ctx-close-others").click();

  // The dirty tab's discard was declined, so it stays; the clean one closed.
  const prompts = await confirmPrompts(page);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.join("\n")).toContain(
    "a.lua has unsaved changes. Close it and discard them?",
  );
  await expect(tab(page, "lab/a.lua")).toBeVisible();
  await expect(tab(page, "lab/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(tab(page, "lab/b.lua")).toHaveCount(0);
  await expect(tab(page, "lab/c.lua")).toHaveAttribute("data-active", "true");
});

test("inapplicable close items disable", async ({ page }) => {
  // Single tab: Close Others has nothing to close.
  await page.getByTestId("open-a").click();
  await openTabMenu(page, "lab/a.lua");
  await expect(page.getByTestId("ctx-close-others")).toHaveAttribute(
    "data-disabled",
  );
  await page.keyboard.press("Escape");

  // Last tab: Close to the Right has nothing to its right.
  await page.getByTestId("open-b").click();
  await openTabMenu(page, "lab/b.lua");
  await expect(page.getByTestId("ctx-close-right")).toHaveAttribute(
    "data-disabled",
  );
});
