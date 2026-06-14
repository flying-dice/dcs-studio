// E2E: the project switch/close guard (issue #25). openPath and closeProject
// discard every open tab; with unsaved edits the developer must confirm ONCE
// (the prompt names how many files are affected), and declining aborts the
// whole operation — tabs, buffers, dirty flags, and the current project all
// stay as they were. Clean tabs never prompt. Runs against the real app over CDP at
// /lab/project-switch: no DCS (model/studio/core.pds OpenProject,
// CloseProject, DecliningProjectSwitchKeepsEverything).

import { test, expect, labUrl, armConfirm, confirmPrompts } from "./_tauri";
import type { Page } from "@playwright/test";

const editor = (page: Page) =>
  page.getByTestId("lab-editor").locator(".cm-content");
const tab = (page: Page, path: string) =>
  page.locator(`[data-testid="editor-tab"][data-path="${path}"]`);
const status = (page: Page) => page.getByTestId("lab-status");

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("project-switch"));
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

  await armConfirm(page, /* accept */ false);
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
  const prompts = await confirmPrompts(page);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.join("\n")).toContain("2 files have unsaved changes");
});

test("declining re-arms the guard: a later switch still prompts and can proceed", async ({
  page,
}) => {
  // Regression guard for the `switching` in-flight flag: the decline arm's
  // early return must still clear it (the `finally`), or the first decline
  // would wedge the app — every later switch/close would silently no-op.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  await armConfirm(page, /* accept */ false);
  await page.getByTestId("switch-project").click();
  await expect(status(page)).toContainText("root: proj-a");
  await expect(status(page)).toContainText("tabs: 1");
  expect((await confirmPrompts(page)).length).toBeGreaterThan(0);

  // Second attempt, accepted this time: must prompt again and proceed.
  await armConfirm(page, /* accept */ true);
  await page.getByTestId("switch-project").click();
  await expect(status(page)).toContainText("root: proj-b");
  await expect(status(page)).toContainText("tabs: 0");
  expect((await confirmPrompts(page)).length).toBeGreaterThan(0);
});

test("with no confirm probe, a dirty switch is still refused (never silently discards)", async ({
  page,
}) => {
  // model ConfirmDiscard: unsaved work is never silently discarded. In the
  // real app the discard confirm is a native Tauri dialog; with the test probe
  // removed it resolves to cancel over CDP, so the guard denies — the switch
  // aborts rather than throwing the edits away.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  await page.evaluate(() => {
    (window as { __dcsConfirm__?: unknown }).__dcsConfirm__ = undefined;
  });
  await page.getByTestId("switch-project").click();
  // Force a later observable delta before asserting "nothing moved", so a
  // not-yet-settled abort can't satisfy the root assertion transiently.
  await page.getByTestId("open-b").click();
  await expect(status(page)).toContainText("tabs: 2");

  await expect(status(page)).toContainText("root: proj-a");
  await expect(tab(page, "proj-a/a.lua")).toHaveAttribute("data-dirty", "true");
  await tab(page, "proj-a/a.lua").click();
  await expect(editor(page)).toContainText('print("edited a")');
});

test("accepting the switch prompt proceeds and clears the tabs", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  await armConfirm(page, /* accept */ true);
  await page.getByTestId("switch-project").click();

  await expect(status(page)).toContainText("root: proj-b");
  await expect(status(page)).toContainText("tabs: 0");
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  const prompts = await confirmPrompts(page);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.join("\n")).toContain("1 file has unsaved changes");
});

test("clean tabs switch projects without any prompt", async ({ page }) => {
  // Open but unedited tabs are no reason to interrupt the developer.
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await page.getByTestId("open-b").click();
  await expect(editor(page)).toContainText('print("beta")');

  await armConfirm(page, /* accept */ false);
  await page.getByTestId("switch-project").click();

  // The switch proceeded — and the watcher (which would have DECLINED any
  // confirm) never fired, proving no dialog stood in the way.
  await expect(status(page)).toContainText("root: proj-b");
  await expect(status(page)).toContainText("tabs: 0");
  expect(await confirmPrompts(page)).toHaveLength(0);
});

test("closing the project with a dirty tab prompts; declining keeps everything", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  await armConfirm(page, /* accept */ false);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: proj-a");
  await expect(status(page)).toContainText("tabs: 1");
  await expect(tab(page, "proj-a/a.lua")).toHaveAttribute("data-dirty", "true");
  await expect(editor(page)).toContainText('print("edited a")');
  const prompts = await confirmPrompts(page);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts.join("\n")).toContain("1 file has unsaved changes");
});

test("accepting the close prompt returns to the welcome state", async ({
  page,
}) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');
  await editor(page).click();
  await editor(page).fill('print("edited a")\n');
  await expect(status(page)).toContainText("dirty: true");

  await armConfirm(page, /* accept */ true);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: (none)");
  await expect(status(page)).toContainText("tabs: 0");
  await expect(page.locator('[data-testid="editor-tab"]')).toHaveCount(0);
  expect((await confirmPrompts(page)).length).toBeGreaterThan(0);
});

test("clean tabs close the project without any prompt", async ({ page }) => {
  await page.getByTestId("open-a").click();
  await expect(editor(page)).toContainText('print("alpha")');

  await armConfirm(page, /* accept */ false);
  await page.getByTestId("close-project").click();

  await expect(status(page)).toContainText("root: (none)");
  await expect(status(page)).toContainText("tabs: 0");
  expect(await confirmPrompts(page)).toHaveLength(0);
});
