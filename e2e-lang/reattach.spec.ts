// E2E: the issue-#31 RE-ATTACH path (LspLuaProvider / RustAnalyzerProvider +
// LspClient — the classes the packaged app runs) over a recording transport
// reporting `isNew=false`. This is the MR's headline behaviour and the one
// the crash/fresh-spawn labs cannot reach: their fakes always report a fresh
// spawn, so the `if (isNew)` skip-branch is otherwise never entered. A
// regression deleting the guard would re-send `initialize` to a live,
// already-initialized server (#31) and still ship green without this.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/reattach");
  await expect(page.getByTestId("reattach-status")).toHaveText("ready", {
    timeout: 30_000,
  });
});

test("a fresh dcs-lua spawn handshakes exactly once, then opens the file", async ({
  page,
}) => {
  // initialize (request) → initialized (notification) → didOpen, in order.
  await expect(page.getByTestId("reattach-lua-fresh-wire")).toHaveText(
    "«initialize,initialized,textDocument/didOpen»",
  );
  // markInitialized records the completed handshake exactly once.
  await expect(page.getByTestId("reattach-lua-fresh-mark")).toHaveText("1");
});

test("a re-attached dcs-lua skips the handshake but still re-opens the file", async ({
  page,
}) => {
  // No initialize, no initialized — only the didOpen replay.
  await expect(page.getByTestId("reattach-lua-re-wire")).toHaveText(
    "«textDocument/didOpen»",
  );
  // markInitialized is NOT touched on a re-attach.
  await expect(page.getByTestId("reattach-lua-re-mark")).toHaveText("0");
});

test("a re-attached dcs-lua still wires the publish + exit handlers", async ({
  page,
}) => {
  // publishDiagnostics handler wired despite the skipped handshake: the
  // didOpen replay surfaces the finding.
  await expect(page.getByTestId("reattach-lua-re-finding")).toHaveText(
    "LUA-E102",
  );
  // Exit handler wired too: a server death after re-attach surfaces on the
  // next edit rather than vanishing silently.
  await expect(page.getByTestId("reattach-lua-re-exit")).toContainText(
    "language server exited",
  );
});

test("a re-attached rust-analyzer skips the handshake and the didOpen storm", async ({
  page,
}) => {
  // rust-analyzer indexes the root itself: a re-attach mount sends nothing on
  // the wire — no initialize, no didOpen.
  await expect(page.getByTestId("reattach-rust-re-wire")).toHaveText("«»");
  await expect(page.getByTestId("reattach-rust-re-mark")).toHaveText("0");
  // The publish handler is still wired — a later edit converts a finding.
  await expect(page.getByTestId("reattach-rust-re-finding")).toHaveText(
    "E0308",
  );
});
