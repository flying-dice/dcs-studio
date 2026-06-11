// E2E: broken Lua typed into the editor surfaces a diagnostic — inline and
// in the Problems panel — via the embedded wasm engine. Runs in a plain
// browser: no Tauri, no DCS (model/studio/lang.pds BrokenLuaShowsDiagnostic).

import { test, expect, type Page } from "@playwright/test";

async function setEditorText(page: Page, code: string): Promise<void> {
  // `.fill` on the contenteditable replaces wholesale and cannot be
  // swallowed by autocompletion popups (same pattern as lua-console.spec).
  const content = page.getByTestId("lab-editor").locator(".cm-content");
  await content.click();
  await content.fill(code);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/lua");
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "editor ready",
    { timeout: 30_000 },
  );
});

test("clean Lua reports no problems", async ({ page }) => {
  await expect(page.getByTestId("problems-panel")).toContainText(
    "No problems detected",
  );
});

test("broken Lua shows a diagnostic inline and in Problems", async ({
  page,
}) => {
  await setEditorText(page, "function f(\n");

  // The Problems panel lists the finding with its stable code…
  const entry = page.getByTestId("problem-entry").first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("LUA-E");

  // …and the editor shows an inline squiggle for the same finding.
  await expect(
    page.getByTestId("lab-editor").locator(".cm-lintRange"),
  ).not.toHaveCount(0);
});

test("fixing the source clears the problems", async ({ page }) => {
  await setEditorText(page, "function f(\n");
  await expect(page.getByTestId("problem-entry").first()).toBeVisible({
    timeout: 15_000,
  });

  await setEditorText(page, "function f() end\n");
  await expect(page.getByTestId("problems-panel")).toContainText(
    "No problems detected",
    { timeout: 15_000 },
  );
});
