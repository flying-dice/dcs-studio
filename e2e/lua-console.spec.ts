// E2E: execute arbitrary Lua in a live DCS through the Lua console UI.
// The console talks to the in-DCS bridge over its WebSocket (the browser
// fallback of dcsCall), so a passing run proves UI → JSON-RPC → DLL →
// DCS hooks environment → and back.

import { test, expect, type Page } from "@playwright/test";

async function runLua(page: Page, code: string): Promise<void> {
  const input = page.getByTestId("lua-console-input").locator(".cm-content");
  await input.click();
  await input.fill(code);
  await page.getByTestId("lua-console-run").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/console");
  // Generous timeout: the first hit on a fresh `vite dev` triggers dependency
  // optimization (CodeMirror etc.) and a mid-load reload.
  await expect(page.getByTestId("lua-console")).toBeVisible({ timeout: 30_000 });
});

test("executes Lua and shows the returned value", async ({ page }) => {
  await runLua(page, "return 21 * 2");

  const entry = page.getByTestId("console-entry").last();
  await expect(entry).toHaveAttribute("data-ok", "true");
  await expect(entry.getByTestId("entry-output")).toHaveText("42");
});

test("serializes Lua table results as JSON", async ({ page }) => {
  await runLua(page, 'return { callsign = "Enfield", flight = 11 }');

  const output = page.getByTestId("console-entry").last().getByTestId("entry-output");
  await expect(output).toContainText('"callsign": "Enfield"');
  await expect(output).toContainText('"flight": 11');
});

test("reaches the real DCS hooks environment", async ({ page }) => {
  await runLua(page, "return lfs.writedir()");

  const output = page.getByTestId("console-entry").last().getByTestId("entry-output");
  await expect(output).toContainText("Saved Games");
});

test("surfaces Lua errors from the bridge", async ({ page }) => {
  await runLua(page, 'error("boom from e2e")');

  const entry = page.getByTestId("console-entry").last();
  await expect(entry).toHaveAttribute("data-ok", "false");
  await expect(entry.getByTestId("entry-output")).toContainText("boom from e2e");
});

test("runs consecutive evaluations against one session", async ({ page }) => {
  await runLua(page, "E2E_COUNTER = (E2E_COUNTER or 0) + 1; return E2E_COUNTER");
  await runLua(page, "E2E_COUNTER = (E2E_COUNTER or 0) + 1; return E2E_COUNTER");

  const entries = page.getByTestId("console-entry");
  await expect(entries).toHaveCount(2);
  const first = Number(await entries.nth(0).getByTestId("entry-output").innerText());
  const second = Number(await entries.nth(1).getByTestId("entry-output").innerText());
  expect(second).toBe(first + 1);
});
