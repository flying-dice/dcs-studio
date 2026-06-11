// E2E: the project switch/close guard (issue #25). openPath and closeProject
// discard every open tab; with unsaved edits the developer must confirm ONCE
// (the prompt names how many files are affected), and declining aborts the
// whole operation — tabs, buffers, dirty flags, and the current project all
// stay as they were. Clean tabs never prompt. Runs in a plain browser against
// /lab/project-switch: no Tauri, no DCS (model/studio/core.pds OpenProject,
// CloseProject, DecliningProjectSwitchKeepsEverything).

import { test, expect, type Page } from "@playwright/test";

const editor = (page: Page) =>
  page.getByTestId("lab-editor").locator(".cm-content");
const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);
const status = (page: Page) => page.getByTestId("lab-status");

/**
 * Arm a dialog watcher BEFORE the action under test: records whether any
 * confirm fired (and its message) and declines/accepts it. The flag is how
 * the no-dialog specs prove the guard stayed silent — Playwright would
 * auto-dismiss an unexpected confirm invisibly otherwise.
 */
function watchDialogs(page: Page, accept: boolean) {
  const seen = { prompted: false, message: "" };
  page.on("dialog", (dialog) => {
    seen.prompted = true;
    seen.message = dialog.message();
    void (accept ? dialog.accept() : dialog.dismiss());
  });
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/project-switch");
  await expect(status(page)).toContainText("ready", { timeout: 30_000 });
  // The initial openPath ran with no tabs open — proj-a is the workspace.
  await expect(status(page)).toContainText("root: proj-a");
});

test("switching projects with dirty tabs prompts once with the count; declining keeps everything", async ({
  page,
}) => {
  // Two tabs, both dirty — the prompt must name the blast radius (2 files).
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(tab(page, "proj-a/a.lua")).toHaveAttribute("data-dirty", "true");

  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("beta")');
  await editor(page).click();
  await editor(page).fill('print("edited b")\n');
  await expect(tab(page, "proj-a/b.lua")).toHaveAttribute("data-dirty", "true");

  const seen = watchDialogs(page, /* accept */ false);
  await page.getByTestId("switch-project").click();

  // Declining aborts the switch entirely: same project, both tabs intact,
  // edits and dirty flags untouched.
  await expect(status(page)).toContainText("root: proj-a");
  await expect(status(page)).toContainText("tabs: 2");
  await expect(tab(page, "proj-a/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(tab(page, "proj-a/b.lua")).toHaveAttribute("data-dirty", "true");
  await expect(editor(page)).toContainText('print("edited b")');
  await tab(page, "proj-a/a.lua").click();
  await expect(editor(page)).toContainText('print("edited a")');
  expect(seen.prompted).toBe(true);
  expect(seen.message).toContain("2 files have unsaved changes");
});

test("accepting the switch prompt proceeds and clears the tabs", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  const seen = watchDialogs(page, /* accept */ true);
  await page.getByTestId("switch-project").click();

  await expect(status(page)).toContainText("root: proj-b");
  await expect(status(page)).toContainText("tabs: 0");
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  expect(seen.prompted).toBe(true);
  expect(seen.message).toContain("1 file has unsaved changes");
});

test("clean tabs switch projects without any prompt", async ({ page }) => {
  // Open but unedited tabs are no reason to interrupt the developer.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("beta")');

  const seen = watchDialogs(page, /* accept */ false);
  await page.getByTestId("switch-project").click();

  // The switch proceeded — and the watcher (which would have DECLINED any
  // confirm) never fired, proving no dialog stood in the way.
  await expect(status(page)).toContainText("root: proj-b");
  await expect(status(page)).toContainText("tabs: 0");
  expect(seen.prompted).toBe(false);
});

test("closing the project with a dirty tab prompts; declining keeps everything", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  const seen = watchDialogs(page, /* accept */ false);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: proj-a");
  await expect(status(page)).toContainText("tabs: 1");
  await expect(tab(page, "proj-a/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(editor(page)).toContainText('print("edited a")');
  expect(seen.prompted).toBe(true);
  expect(seen.message).toContain("1 file has unsaved changes");
});

test("accepting the close prompt returns to the welcome state", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  const seen = watchDialogs(page, /* accept */ true);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: (none)");
  await expect(status(page)).toContainText("tabs: 0");
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  expect(seen.prompted).toBe(true);
});

test("clean tabs close the project without any prompt", async ({ page }) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');

  const seen = watchDialogs(page, /* accept */ false);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: (none)");
  await expect(status(page)).toContainText("tabs: 0");
  expect(seen.prompted).toBe(false);
});
