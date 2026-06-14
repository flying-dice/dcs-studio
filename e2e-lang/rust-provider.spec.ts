// E2E: the rust-analyzer provider path (RustAnalyzerProvider + LspClient —
// the classes the packaged app runs) over an in-page fake server speaking
// rust-analyzer's wire shapes. Covers rootUri forwarding on initialize,
// publishDiagnostics conversion for .rs sources, and the no-Cargo.toml
// root disabling the provider without a crash.

import { test, expect, labUrl } from "./_tauri";

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("rust"));
  await expect(page.getByTestId("rust-status")).toHaveText("ready", {
    timeout: 30_000,
  });
});

test("initialize carries the workspace rootUri and diagnostics convert to exact offsets", async ({
  page,
}) => {
  // rust-analyzer indexes the project itself: mount must forward the
  // workspace root as a file URI.
  await expect(page.getByTestId("rust-root")).toHaveText(
    "root: file:///C:/lab/rsproj",
  );
  const finding = page.getByTestId("rust-finding").first();
  await expect(finding).toContainText("E0308");
  // Line 2, on the `"oops"` literal.
  await expect(finding).toContainText("@ 2:18");
  // The converted offsets slice the document exactly onto the offender.
  await expect(page.getByTestId("rust-marked")).toHaveText('marked: «"oops"»');
});

test("a root without a Cargo.toml disables the provider, no crash", async ({
  page,
}) => {
  await expect(page.getByTestId("rust-disabled")).toHaveText("disabled");
});

test("a missing rust-analyzer binary never fails the intel layer", async ({
  page,
}) => {
  // A real LangIntel mounting two providers: a Lua provider with one
  // finding and a real RustAnalyzerProvider whose connect rejects like a
  // missing binary. The layer must end "ready" — NOT "failed" — with the
  // Lua finding intact (model `RustProjectGetsDiagnostics`).
  await page.getByTestId("intel-mount").click();
  await expect(page.getByTestId("intel-status")).toHaveText("ready");
  const finding = page.getByTestId("intel-finding").first();
  await expect(finding).toContainText("/X/x.lua");
  await expect(finding).toContainText("LUA-E102");
});
