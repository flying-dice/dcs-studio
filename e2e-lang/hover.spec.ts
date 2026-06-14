// E2E: the hover probe — the hosted lua-analyzer engine's resolution-backed
// hover card (model/lspcore.pds HoverExplainsDeclarations) through the real
// provider stack in the REAL app.
//
// The hosted server answers hover as a markdown BODY (a fenced `lua`
// signature block followed by the doc text), with no separate title — the
// same MarkupContent convention rust-analyzer uses and the client renders
// verbatim (see lsp-client.spec). So the signature and the doc both land in
// the body; the title stays empty.

import { test, expect, labUrl } from "./_tauri";

test("hover probe explains the documented local", async ({ page }) => {
  await page.goto(labUrl("lua"));
  await expect(page.getByTestId("lab-engine-status")).toContainText(
    "editor ready",
    { timeout: 30_000 },
  );

  await page.getByTestId("hover-probe").click();
  const body = page.getByTestId("hover-body");
  await expect(body).toContainText("local f: function()");
  await expect(body).toContainText("Doc for f.");
});
