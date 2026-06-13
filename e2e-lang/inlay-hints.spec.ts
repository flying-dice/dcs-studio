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

test("a function signature shows inferred parameter and return hints", async ({
  page,
}) => {
  await setEditorText(page, "local function f(p)\n  return p:upper()\nend\n");

  // `p: string` (from the `:upper()` use) and the `: string` return type —
  // two ghost hints rendered on the signature.
  const hints = page
    .getByTestId("lab-editor")
    .locator(".cm-inlay-hint")
    .filter({ hasText: ": string" });
  await expect(hints).toHaveCount(2, { timeout: 15_000 });
});

test("a number passed to a string param is reported (param-type-mismatch)", async ({
  page,
}) => {
  await setEditorText(
    page,
    "--- @param msg string\nlocal function log(msg) end\nlog(1)\n",
  );

  const entry = page.getByTestId("problem-entry").first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("param-type-mismatch");
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

test("arithmetic on a table is warned (operator-type-mismatch)", async ({ page }) => {
  await setEditorText(page, "local total = {} + 1\n");

  const entry = page.getByTestId("problem-entry").first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("operator-type-mismatch");
});

test("a string argument to a numerically-used parameter is warned (param-usage-mismatch)", async ({
  page,
}) => {
  // `v` is used as `v * 2`, so passing a string conflicts with that usage.
  await setEditorText(page, 'local function scale(v)\n  return v * 2\nend\nscale("x")\n');

  const entry = page.getByTestId("problem-entry").first();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await expect(entry).toContainText("param-usage-mismatch");
});

test("an inline ---@allow directive silences the lint", async ({ page }) => {
  // Without the directive this is operator-type-mismatch; `---@allow` silences it.
  await setEditorText(
    page,
    "---@allow operator-type-mismatch\nlocal total = {} + 1\n",
  );

  await expect(page.getByTestId("problems-panel")).toContainText(
    "No problems detected",
    { timeout: 15_000 },
  );
});
