// E2E: the hover probe — the wasm engine's resolution-backed hover card
// (model/lspcore.pds HoverExplainsDeclarations) through the real provider
// stack in a plain browser: declaration headline, inferred type, doc text.

import { test, expect } from "@playwright/test";

test("hover probe explains the documented local", async ({ page }) => {
  await page.goto("/lab/lua");
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "editor ready",
    { timeout: 30_000 },
  );

  await page.getByTestId("hover-probe").click();
  await expect(page.getByTestId("hover-title")).toContainText(
    "local f: function()",
  );
  await expect(page.getByTestId("hover-body")).toContainText("Doc for f.");
});
