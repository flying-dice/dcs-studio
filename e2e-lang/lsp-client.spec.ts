// E2E: the production LSP client path (LspClient + LspLuaProvider — the
// classes the packaged app runs) over an in-page fake server speaking the
// real wire shapes. Covers request correlation, publishDiagnostics push,
// UTF-16 conversion on non-ASCII text, and the crash path.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/lsp");
  await expect(page.getByTestId("lsp-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("diagnostics arrive via push and convert to exact UTF-16 offsets", async ({
  page,
}) => {
  const finding = page.getByTestId("lsp-finding").first();
  await expect(finding).toContainText("LUA-E102");
  // Line 2, on the `(` of `function f(` — column survives the Cyrillic
  // comment on line 1.
  await expect(finding).toContainText("@ 2:11");
  // The converted offsets slice the document exactly onto the offender.
  await expect(page.getByTestId("lsp-marked")).toHaveText("marked: «(»");
});

test("a server crash rejects the path instead of hanging", async ({
  page,
}) => {
  await page.getByTestId("lsp-crash").click();
  await expect(page.getByTestId("lsp-status")).toContainText("server exited");
  await expect(page.getByTestId("lsp-after-crash")).toContainText(
    "language server exited",
    { timeout: 10_000 },
  );
});
