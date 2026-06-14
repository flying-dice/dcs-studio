// E2E: file-tree workspace mutations (issue #17) — rename-follow, the dirty-
// rename refusal, delete-closes-tab, and the collision guard — driving the REAL
// guarded fs commands + open-tab coordination over CDP against a real temp
// workspace seeded with a.lua + b.lua, with a.lua open. Guards
// model/studio/core.pds RenameWorkspacePath / DeleteWorkspacePath and the
// RenamingOpenFileFollowsInEditor feature.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

async function openFiles(page: Page): Promise<string> {
  return (await page.getByTestId("open-files").textContent()) ?? "";
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("tree"));
  await expect(page.getByTestId("lab-status")).toHaveText("ready", {
    timeout: 15_000,
  });
  // a.lua is the open, active tab.
  await expect(page.getByTestId("open-files")).toHaveText("a.lua");
});

test("renaming a clean open file follows it to the new path", async ({ page }) => {
  await page.getByTestId("rename-clean").click();
  // The tab now points at the renamed file, not the vanished one.
  await expect.poll(() => openFiles(page)).toBe("c.lua");
  await expect(page.getByTestId("active-file")).toHaveText("c.lua");
  await expect(page.getByTestId("error")).toHaveText("");
});

test("renaming onto an existing file is refused and the tab is unchanged", async ({ page }) => {
  await page.getByTestId("rename-collision").click();
  await expect(page.getByTestId("error")).toContainText("exists");
  // a.lua's tab is untouched.
  await expect(page.getByTestId("open-files")).toHaveText("a.lua");
});

test("renaming a file with unsaved edits is refused until it is saved", async ({ page }) => {
  await page.getByTestId("rename-dirty").click();
  await expect(page.getByTestId("error")).toContainText("Save");
  // The dirty tab did NOT follow — it is still a.lua, unrenamed.
  await expect(page.getByTestId("open-files")).toHaveText("a.lua");
});

test("deleting an open file closes its tab", async ({ page }) => {
  await page.getByTestId("delete-open").click();
  // The deleted file's tab is gone (no tabs left).
  await expect.poll(() => openFiles(page)).toBe("");
  await expect(page.getByTestId("error")).toHaveText("");
});

test("creating a file opens it as a new tab", async ({ page }) => {
  await page.getByTestId("create-file").click();
  await expect.poll(() => openFiles(page)).toContain("new.lua");
});
