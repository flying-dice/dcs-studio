// E2E: inferred-type inlay hints (ghost text) and call-site type checking
// through the real wasm engine in a plain browser — no Tauri, no DCS
// (model/lspcore.pds InferredTypesShowAsInlayHints, ArgumentTypeIsChecked).

import { test, expect, type Page } from "@playwright/test";

async function setEditorText(page: Page, code: string): Promise<void> {
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

test("an unannotated local shows an inferred-type ghost hint", async ({
  page,
}) => {
  await setEditorText(page, 'local name = "viper"\nlocal count = 3\n');

  const hints = page.getByTestId("lab-editor").locator(".cm-inlay-hint");
  await expect(hints.filter({ hasText: ": string" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(hints.filter({ hasText: ": number" })).toBeVisible();
});

test("a number passed to a string param is reported (LUA-T001)", async ({
  page,
}) => {
  await setEditorText(
    page,
    "--- @param msg string\nlocal function log(msg) end\nlog(1)\n",
  );

  const entry = page.getByTestId("problem-entry").first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("LUA-T001");
});

test("a correctly typed argument reports no problem", async ({ page }) => {
  await setEditorText(
    page,
    '--- @param msg string\nlocal function log(msg) end\nlog("hello")\n',
  );

  await expect(page.getByTestId("problems-panel")).toContainText(
    "No problems detected",
    { timeout: 15_000 },
  );
});
