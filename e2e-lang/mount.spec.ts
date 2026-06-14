// E2E: the workspace-mount path — the race guard on rapid project
// switching, the unreadable-file skip, and reset — via the /lab/mount
// surface's fake filesystem. No Tauri, no DCS.

import { test, expect, labUrl } from "./_tauri";

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("mount"));
  await expect(page.getByTestId("mount-lab")).toBeVisible({ timeout: 30_000 });
});

test("opening another project mid-walk keeps only the newer findings", async ({
  page,
}) => {
  // A's walk takes ~600ms; B mounts immediately after. The generation
  // guard must let B win even though A finishes later.
  await page.getByTestId("mount-a").click();
  await page.getByTestId("mount-b").click();

  await expect(page.getByTestId("mount-status")).toHaveText("status: ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("mount-finding")).toHaveCount(1);
  await expect(page.getByTestId("mount-finding")).toContainText("/B/b.lua");

  // Give A's superseded walk time to land — it must change nothing.
  await page.waitForTimeout(1200);
  await expect(page.getByTestId("mount-finding")).toHaveCount(1);
  await expect(page.getByTestId("mount-finding")).toContainText("/B/b.lua");
});

test("an unreadable file is skipped, not fatal", async ({ page }) => {
  // /B contains locked.lua whose read throws; the mount must still come
  // up ready with b.lua's finding.
  await page.getByTestId("mount-b").click();
  await expect(page.getByTestId("mount-status")).toHaveText("status: ready", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("mount-finding")).toContainText("/B/b.lua");
});

test("reset clears findings and status", async ({ page }) => {
  await page.getByTestId("mount-b").click();
  await expect(page.getByTestId("mount-finding")).toHaveCount(1, {
    timeout: 15_000,
  });

  await page.getByTestId("mount-reset").click();
  await expect(page.getByTestId("mount-status")).toHaveText("status: off");
  await expect(page.getByTestId("mount-finding")).toHaveCount(0);
});
