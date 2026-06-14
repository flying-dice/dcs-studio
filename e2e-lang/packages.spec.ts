// E2E: signed packages (issue #37) over the REAL app + the mock signing server
// the harness spawns. Packs a fixture project, installs it, then revokes the
// author and revalidates — proving the whole app path including the revocation
// gate. Skips cleanly if the mock server / signing env isn't present.

import { test, expect, labUrl } from "./_tauri";
import type { Page } from "@playwright/test";

const PKG = "E2E Pkg";

async function text(page: Page, id: string): Promise<string> {
  return (await page.getByTestId(id).textContent()) ?? "";
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("packages"));
  const status = page.getByTestId("lab-status");
  await expect(status).not.toHaveText("loading", { timeout: 20_000 });
  // No mock server / signing env (e.g. a partial local run) → skip, don't fail.
  test.skip(
    (await status.textContent())?.startsWith("error") ?? false,
    "signing server unavailable",
  );
});

test("pack → install → revoke → stale", async ({ page }) => {
  // Pack the fixture project: it appears in the discovery folder.
  await page.getByTestId("do-pack").click();
  await expect.poll(() => text(page, "discovered")).toContain(PKG);

  // Install it: it shows under installed, and is NOT stale yet.
  await page.getByTestId("do-install").click();
  await expect.poll(() => text(page, "installed")).toContain(PKG);
  await expect(page.getByTestId("error")).toHaveText("");
  expect(await text(page, "stale")).toBe("stale: ");

  // Revoke the author on the server, then revalidate — the installed package is
  // now flagged stale, the heart of revocation (model RevokedAuthorBecomesStale).
  await page.getByTestId("do-revoke").click();
  await page.getByTestId("do-revalidate").click();
  await expect.poll(() => text(page, "stale")).not.toBe("stale: ");
  // Still listed as installed, but marked stale.
  await expect.poll(() => text(page, "installed")).toContain(PKG);
  // The REAL PackagesManager renders the revoked badge (prod wiring, not the
  // lab's re-implementation).
  await expect(page.getByTestId("pkg-stale-badge").first()).toBeVisible();
});
