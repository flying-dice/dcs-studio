// E2E: the engine refactorings (issue #18) — go-to-definition, find-usages, and
// rename — driving the REAL lua-analyzer provider over CDP. /lab/refactor mounts
// two Lua files (lib.lua declares the global `shared`, main.lua uses it twice)
// and calls the provider's definition / references / rename directly, so this
// guards the whole frontend path: provider request → real LSP server →
// lsp-wire conversion back to our shapes.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

async function result(page: Page): Promise<string> {
  return (await page.getByTestId("result").textContent()) ?? "";
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("refactor"));
  await expect(page.getByTestId("lab-status")).toContainText("ready");
});

test("definition jumps from a use to the cross-file declaration", async ({ page }) => {
  await page.getByTestId("run-definition").click();
  await expect.poll(() => result(page)).not.toBe("");
  const loc = JSON.parse(await result(page));
  // The use in main.lua resolves to lib.lua's declaration, landing on the
  // function name `shared` (byte 9), not the `function` keyword.
  expect(loc.path).toContain("lib.lua");
  expect(loc.start).toBe(9);
  expect(loc.end).toBe(15);
});

test("references collect the declaration plus every use across files", async ({ page }) => {
  await page.getByTestId("run-references").click();
  await expect.poll(() => result(page)).not.toBe("");
  const refs = JSON.parse(await result(page));
  // Declaration in lib.lua + two uses in main.lua.
  expect(refs).toHaveLength(3);
  const paths = refs.map((r: { path: string }) => r.path);
  expect(paths.some((p: string) => p.includes("lib.lua"))).toBe(true);
  expect(paths.filter((p: string) => p.includes("main.lua"))).toHaveLength(2);
});

test("rename produces a multi-file edit set", async ({ page }) => {
  await page.getByTestId("run-rename").click();
  await expect.poll(() => result(page)).not.toBe("");
  const edit = JSON.parse(await result(page));
  expect(edit.edits).toHaveLength(3);
  expect(edit.edits.every((e: { newText: string }) => e.newText === "renamed")).toBe(true);
  // Two files touched.
  const paths = new Set(edit.edits.map((e: { path: string }) => e.path));
  expect(paths.size).toBe(2);
});

test("rename to an invalid identifier is refused with a message", async ({ page }) => {
  await page.getByTestId("run-rename-invalid").click();
  await expect.poll(async () =>
    (await page.getByTestId("error").textContent()) ?? "",
  ).not.toBe("");
  // The engine's refusal message reaches the editor (not a silent no-op).
  expect(await page.getByTestId("error").textContent()).toMatch(/identifier|valid/i);
  // And no edit was produced.
  expect(await result(page)).toBe("");
});
