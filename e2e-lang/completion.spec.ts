// E2E: the completion path (issue #52) — the hosted lua-analyzer's
// `textDocument/completion` through the real provider stack in the REAL app.
//
// Two layers are guarded:
//   - the provider query, via /lab/lua's completion probes: provider.complete →
//     real LSP server → lsp-wire conversion back to our enriched CompletionItem
//     (label, kind, detail, documentation, insertText, insertTextFormat). The
//     probes complete at fixed offsets and render the items as JSON, so the
//     assertions are exact and order-free — the refactor.spec idiom.
//   - the CodeMirror autocomplete source itself: typing `.` drives the live
//     popup and accepting a function inserts its snippet.
//
// The typed `@class`/`.d.lua` member path is covered by the engine's own unit
// tests (it needs the generated declaration file the lab doesn't mount); here
// the DCS API surface is exercised through its dotted-global form (`DCS.x = …`),
// which is how it actually lands in a project.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

/** The JSON the last completion probe rendered. */
async function result(page: Page): Promise<string> {
  return (await page.getByTestId("completion-result").textContent()) ?? "";
}

/** The editor's current text (CodeMirror concatenates its lines). */
async function doc(page: Page): Promise<string> {
  return (
    (await page.getByTestId("lab-editor").locator(".cm-content").textContent()) ?? ""
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("lua"));
  // The first spec after app launch spawns lua-analyzer cold — allow for it.
  await expect(page.getByTestId("lab-engine-status")).toContainText("editor ready", {
    timeout: 30_000,
  });
});

test("inferred local-literal members complete with kinds, snippet, and docs", async ({
  page,
}) => {
  await page.getByTestId("completion-members-probe").click();
  await expect.poll(() => result(page)).not.toBe("");
  const items = JSON.parse(await result(page));
  const byLabel = Object.fromEntries(items.map((i: { label: string }) => [i.label, i]));

  // `local cfg = { speed = 1, name = "x", start = function() end }`.
  expect(Object.keys(byLabel).sort()).toEqual(["name", "speed", "start"]);
  // A literal field is a Field; a function-valued field is a Function.
  expect(byLabel.speed.kind).toBe("field");
  expect(byLabel.name.kind).toBe("field");
  expect(byLabel.start.kind).toBe("function");
  // The function member inserts a snippet; a plain field inserts its label.
  expect(byLabel.start.insertTextFormat).toBe("snippet");
  expect(byLabel.start.insertText).toBe("start()");
  expect(byLabel.speed.insertTextFormat).toBe("plaintext");
  expect(byLabel.speed.insertText).toBe("speed");
});

test("dotted-global members complete — the DCS API surface", async ({ page }) => {
  await page.getByTestId("completion-dotted-probe").click();
  await expect.poll(() => result(page)).not.toBe("");
  const items = JSON.parse(await result(page));
  const labels = items.map((i: { label: string }) => i.label);

  // `DCS.spawn = function(unit) end` and `DCS.version = 1`.
  expect(labels).toContain("spawn");
  expect(labels).toContain("version");
  const spawn = items.find((i: { label: string }) => i.label === "spawn");
  expect(spawn.kind).toBe("function");
  expect(spawn.insertTextFormat).toBe("snippet");
  expect(spawn.insertText).toBe("spawn(${1:unit})");
});

test("a bare-identifier prefix unions in-scope locals and workspace globals", async ({
  page,
}) => {
  await page.getByTestId("completion-scope-probe").click();
  await expect.poll(() => result(page)).not.toBe("");
  const items = JSON.parse(await result(page));
  const byLabel = Object.fromEntries(items.map((i: { label: string }) => [i.label, i]));

  // The prefix `spaw` matches the in-scope local `spawnRate` and the workspace
  // global `spawnUnit` — and nothing else.
  expect(byLabel.spawnRate.kind).toBe("variable");
  expect(byLabel.spawnUnit.kind).toBe("function");
  // The global function carries a parameter snippet from its signature.
  expect(byLabel.spawnUnit.insertText).toBe("spawnUnit(${1:country}, ${2:name})");
  expect(byLabel.spawnUnit.insertTextFormat).toBe("snippet");
});

test("completion stays silent inside a comment", async ({ page }) => {
  await page.getByTestId("completion-comment-probe").click();
  await expect.poll(() => result(page)).toBe("[]");
});

test("typing a dot drives the editor autocomplete popup and inserts a snippet", async ({
  page,
}) => {
  const editor = page.getByTestId("lab-editor");
  await editor.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("cfg.");

  // The `.` member trigger opens the popup with the literal's fields.
  const popup = editor.locator(".cm-tooltip-autocomplete");
  await expect(popup).toBeVisible({ timeout: 15_000 });
  await expect(popup).toContainText("speed");
  await expect(popup).toContainText("start");

  // Narrow to `start` and accept — the function snippet inserts `start()`.
  await page.keyboard.type("st");
  await page.keyboard.press("Enter");
  await expect.poll(() => doc(page)).toContain("cfg.start(");
});
