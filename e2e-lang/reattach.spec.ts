// E2E: the issue-#31 RE-ATTACH path (LuaAnalyzerProvider / RustAnalyzerProvider
// + LspClient — the classes the packaged app runs) over a recording transport
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

test("a fresh dcs-lua spawn handshakes exactly once (root-bound, no didOpen storm)", async ({
  page,
}) => {
  // lua-analyzer indexes the root itself: a fresh mount handshakes only —
  // initialize (request) → initialized (notification), no didOpen.
  await expect(page.getByTestId("reattach-lua-fresh-wire")).toHaveText(
    "«initialize,initialized»",
  );
  // markInitialized records the completed handshake exactly once.
  await expect(page.getByTestId("reattach-lua-fresh-mark")).toHaveText("1");
});

test("a re-attached dcs-lua skips the handshake and the didOpen storm", async ({
  page,
}) => {
  // Root-bound re-attach sends nothing on mount: no initialize, no
  // initialized, no didOpen — the server is already indexing this root.
  await expect(page.getByTestId("reattach-lua-re-wire")).toHaveText("«»");
  // markInitialized is NOT touched on a re-attach.
  await expect(page.getByTestId("reattach-lua-re-mark")).toHaveText("0");
});

test("a re-attached dcs-lua still wires the publish + exit handlers", async ({
  page,
}) => {
  // publishDiagnostics handler wired despite the skipped handshake: a later
  // edit opens the file and surfaces the finding.
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

test("a re-attach after a project-root switch spawns fresh and re-initializes against the new root", async ({
  page,
}) => {
  // The MR's headline regression (CODEOWNER, MR !20): rust-analyzer is
  // root-bound, so a reload that re-attaches to the OLD-rooted server leaves
  // Rust diagnostics silently dead. After the fix a SWITCHED root must NOT
  // reuse it — a fresh handshake runs (initialize → initialized), and it
  // carries the NEW rootUri, not the stale one.
  await expect(page.getByTestId("reattach-rust-switch-wire")).toHaveText(
    "«initialize,initialized»",
  );
  await expect(page.getByTestId("reattach-rust-switch-initroot")).toContainText(
    "proj-b",
  );
  await expect(
    page.getByTestId("reattach-rust-switch-initroot"),
  ).not.toContainText("proj-a");
  // Diagnostics for the NEW root surface — the "findings refresh" the old
  // root-blind re-attach could never deliver.
  await expect(page.getByTestId("reattach-rust-switch-finding")).toHaveText(
    "E0308",
  );
});

test("a re-attach to the unchanged root still skips the handshake", async ({
  page,
}) => {
  // Re-opening the SAME root after the switch re-attaches warm — issue #31's
  // skip-handshake path, intact for an unchanged root (no re-init regression).
  await expect(page.getByTestId("reattach-rust-same-wire")).toHaveText("«»");
});
