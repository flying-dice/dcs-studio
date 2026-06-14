// E2E: the production LSP client path (LspClient + LspLuaProvider — the
// classes the packaged app runs) over an in-page fake server speaking the
// real wire shapes. Covers request correlation, publishDiagnostics push,
// UTF-16 conversion on non-ASCII text, and the crash path.

import { test, expect, labUrl } from "./_tauri";

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("lsp"));
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

test("a server-to-client request gets answered, not ignored", async ({
  page,
}) => {
  // The fake server sends `client/registerCapability` (id 999) right
  // after initialize — rust-analyzer stalls if such requests go
  // unanswered, so the client must reply with result null.
  await expect(page.getByTestId("lsp-server-req")).toHaveText("answered");
});

test("hover answers render the server's markdown verbatim as the body", async ({
  page,
}) => {
  // The fake answers textDocument/hover with fenced MarkupContent (the
  // convention rust-analyzer and lua-analyzer share); the provider renders it
  // as the card body with no title reconstruction.
  await page.getByTestId("lsp-hover").click();
  await expect(page.getByTestId("lsp-hover-title")).toHaveText("");
  await expect(page.getByTestId("lsp-hover-body")).toContainText(
    "local x: number",
  );
  await expect(page.getByTestId("lsp-hover-body")).toContainText("the answer");
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

test("mount after a crash reconnects on the same root", async ({ page }) => {
  await page.getByTestId("lsp-crash").click();
  await expect(page.getByTestId("lsp-after-crash")).toContainText(
    "language server exited",
    { timeout: 10_000 },
  );
  // The crash blanked the findings; a remount must bring them back via a
  // FRESH connection — the dead session may not be reused.
  await expect(page.getByTestId("lsp-marked")).toHaveText("marked: «»");
  await page.getByTestId("lsp-remount").click();
  await expect(page.getByTestId("lsp-status")).toContainText("server alive");
  const finding = page.getByTestId("lsp-finding").first();
  await expect(finding).toContainText("LUA-E102");
  await expect(page.getByTestId("lsp-marked")).toHaveText("marked: «(»");
});
