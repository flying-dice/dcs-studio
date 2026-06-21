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
  // This route now mounts the real FileTree (its context menus are under test),
  // which pulls in a heavier module graph; an isolated cold run pays vite's
  // on-demand first compile here, so allow generous headroom for "ready".
  await expect(page.getByTestId("lab-status")).toHaveText("ready", {
    timeout: 30_000,
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

test("renaming a background file keeps focus on the active tab", async ({ page }) => {
  // model RetargetTabs: the previously active tab stays active. a.lua is
  // active; renaming background b.lua → c.lua must not steal focus.
  await page.getByTestId("rename-background").click();
  await expect.poll(() => openFiles(page)).toContain("c.lua");
  // Focus stayed on a.lua, NOT yanked to the renamed background tab.
  await expect(page.getByTestId("active-file")).toHaveText("a.lua");
  await expect(page.getByTestId("error")).toHaveText("");
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

test("right-clicking empty tree space opens the root menu and creates at the root", async ({ page }) => {
  // The root/empty-space context menu (not bound to any node) targets the
  // workspace root. Right-click low in the host, below the seeded a/b nodes.
  await page.getByTestId("tree-host").click({ button: "right", position: { x: 40, y: 230 } });
  await expect(page.getByTestId("tree-root-context-menu")).toBeVisible();
  await page.getByTestId("ctx-root-new-file").click();
  const input = page.getByTestId("tree-create-input");
  await expect(input).toBeVisible();
  // The box must SURVIVE the menu's close: bits-ui's focus scope releases focus
  // after the ~100ms close animation, which used to blur the box and auto-close
  // it. Dwell past that window, then assert it is still there before typing.
  await page.waitForTimeout(400);
  await expect(input).toBeVisible();
  await input.fill("rooted.lua");
  await input.press("Enter");
  // createEntry opens a new file, so it lands as a tab labelled from the path.
  await expect.poll(() => openFiles(page)).toContain("rooted.lua");
});

test("the create box does NOT close when another element steals focus", async ({ page }) => {
  // The genuine-UI bug: the IDE around the tree grabs focus the instant the box
  // opens; with a blur-commit the box vanished. It must commit only on Enter or
  // a real outside click, so a programmatic focus steal leaves it open.
  await page.getByTestId("tree-host").click({ button: "right", position: { x: 40, y: 230 } });
  await page.getByTestId("ctx-root-new-file").click();
  const input = page.getByTestId("tree-create-input");
  await expect(input).toBeVisible();
  await page.getByTestId("focus-thief").focus();
  await expect(input).toBeVisible();
  // Refocusing and typing still works, and Enter commits.
  await input.fill("kept.lua");
  await input.press("Enter");
  await expect.poll(() => openFiles(page)).toContain("kept.lua");
});

test("the create box survives the real 5s SWR poll", async ({ page }) => {
  await page.getByTestId("tree-host").click({ button: "right", position: { x: 40, y: 230 } });
  await page.getByTestId("ctx-root-new-file").click();
  const input = page.getByTestId("tree-create-input");
  await expect(input).toBeVisible();
  // Wait past the real 5s poll interval (the SWR effect is live in the lab too).
  // While the box is open the poll is suspended, so the tree never reloads under
  // it; the box stays put.
  await page.waitForTimeout(6500);
  await expect(input).toBeVisible();
});

test("right-clicking a node opens the node menu, not the root menu", async ({ page }) => {
  // bits-ui marks the node trigger's contextmenu handled (preventDefault), so
  // the bubbled event no-ops at the outer root trigger — only one menu opens.
  await page.getByTestId("tree-node").first().click({ button: "right" });
  await expect(page.getByTestId("tree-context-menu")).toBeVisible();
  await expect(page.getByTestId("tree-root-context-menu")).toHaveCount(0);
});

test("a tree refresh keeps expanded subfolders open", async ({ page }) => {
  // Expand the seeded `sub/` folder, reveal its child, then refresh the tree
  // (the SWR poll / a mutation bumps treeVersion). The keyed-each must
  // reconcile in place — the subtree must NOT be torn down and collapsed.
  await page.getByTestId("tree-node").filter({ hasText: "sub" }).click();
  await expect(page.getByTestId("tree-node").filter({ hasText: "nested.lua" })).toBeVisible();
  await page.getByTestId("refresh-tree").click();
  // Give a refreshed read time to resolve, then confirm it stayed expanded.
  await page.waitForTimeout(400);
  await expect(page.getByTestId("tree-node").filter({ hasText: "nested.lua" })).toBeVisible();
});

test("a per-node New File box inside a folder survives a refresh", async ({ page }) => {
  // The hardest case: a create box opened on a node INSIDE an expanded folder.
  // A refresh (poll/mutation) reloads that folder's children — the box must
  // survive (it used to die when the loading flash tore down the subtree).
  await page.getByTestId("tree-node").filter({ hasText: "sub" }).click();
  const nested = page.getByTestId("tree-node").filter({ hasText: "nested.lua" });
  await expect(nested).toBeVisible();
  await nested.click({ button: "right" });
  await page.getByTestId("tree-context-menu").getByText("New File…").click();
  const input = page.getByTestId("tree-create-input");
  await expect(input).toBeVisible();
  // Refresh the way the poll does — a treeVersion bump with no focus change
  // (clicking a button would blur the box and commit-close it, by design).
  await page.evaluate(() => {
    (window as unknown as { __refreshTree__: () => void }).__refreshTree__();
  });
  await page.waitForTimeout(400);
  await expect(input).toBeVisible();
});

test("the per-node New File box survives the menu close", async ({ page }) => {
  // Same focus-scope hazard on the per-node menu: the box must not auto-close
  // when the menu's focus scope releases.
  await page.getByTestId("tree-node").first().click({ button: "right" });
  await page.getByTestId("tree-context-menu").getByText("New File…").click();
  const input = page.getByTestId("tree-create-input");
  await expect(input).toBeVisible();
  await page.waitForTimeout(400);
  await expect(input).toBeVisible();
  await input.fill("beside.lua");
  await input.press("Enter");
  await expect.poll(() => openFiles(page)).toContain("beside.lua");
});
