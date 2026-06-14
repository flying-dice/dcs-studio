// E2E: binary files open a Fleet-style placeholder instead of closing their
// own tab (issue #30). Runs against the real app over CDP at /lab/buffers:
// no DCS. The lab's in-memory store is FileLoad-shaped, so the real classify
// path drives the placeholder; reveal-in-explorer / open-with-app are isTauri()
// no-ops here (model/studio/core.pds BinaryFileShowsPlaceholder).

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

const overlay = (page: Page) => page.getByTestId("binary-overlay");
const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);
const editor = (page: Page) =>
  page.getByTestId("lab-editor").locator(".cm-content");

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("buffers"));
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("a binary file opens a placeholder tab and never closes itself", async ({
  page,
}) => {
  // The issue-#30 regression: before, the failed UTF-8 read closed the tab and
  // the file vanished. Now it opens a normal tab with the placeholder.
  await page.getByTestId("open-bin").click();

  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toContainText(
    "The file is not shown because it is binary.",
  );
  // formatBytes(4096) — the size the lab marks bin.dat with.
  await expect(overlay(page)).toContainText("4.0 KB");

  // The tab is still there — it did not close itself.
  await expect(tab(page, "lab/bin.dat")).toHaveCount(1);
  await expect(tab(page, "lab/bin.dat")).toHaveAttribute("data-active", "true");
});

test("the placeholder's OS actions render and are click-safe in the browser", async ({
  page,
}) => {
  await page.getByTestId("open-bin").click();
  await expect(overlay(page)).toBeVisible();

  // Both actions render; clicking them is an isTauri() no-op in a plain
  // browser (revealItemInDir / openPath), so neither throws nor dismisses the
  // placeholder.
  const reveal = page.getByRole("button", { name: "Open in Explorer" });
  const openWith = page.getByRole("button", {
    name: "Open in associated application",
  });
  await expect(reveal).toBeVisible();
  await expect(openWith).toBeVisible();

  await reveal.click();
  await openWith.click();
  await expect(overlay(page)).toBeVisible();
});

test("switching off a binary tab and back restores the placeholder", async ({
  page,
}) => {
  // The known-binary fast-path: a re-activated binary tab shows the blank view
  // behind the placeholder again, with no re-read.
  await page.getByTestId("open-bin").click();
  await expect(overlay(page)).toBeVisible();

  // Switch to a text tab: the placeholder is gone and the editor shows text.
  await page.getByTestId("open-a").click();
  await expect(overlay(page)).toHaveCount(0);
  await expect(editor(page)).toContainText('print("hello")');

  // Back to the binary tab: the placeholder returns; both tabs still open.
  await tab(page, "lab/bin.dat").click();
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toContainText("4.0 KB");
  await expect(tab(page, "lab/a.lua")).toHaveCount(1);
});
