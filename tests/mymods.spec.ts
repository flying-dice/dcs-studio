import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

test.describe("My Mods — entrypoints", () => {
  test("shows entrypoint rows only for enabled mods that declare them", async ({ page }) => {
    const errors = await openPreview(page, "mymods");
    // Only the enabled DCS-SRS mod (2 entrypoints) renders an entrypoints block;
    // the disabled mod's entrypoint and the plain enabled mod are excluded.
    await expect(page.getByTestId("entrypoints")).toHaveCount(1);
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(2);

    const srs = page.locator('[data-ep="Owner/DCS-SRS::srs-server"]');
    await expect(srs.locator(".ep-name")).toHaveText("SRS Server");
    await expect(srs.locator(".ep-exe")).toHaveText("Server/SR-Server.exe");
    await expect(srs.getByTestId("launch-btn")).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("launch → running → stop transitions via scripted host replies", async ({ page }) => {
    await openPreview(page, "mymods");
    const srs = page.locator('[data-ep="Owner/DCS-SRS::srs-server"]');

    await srs.getByTestId("launch-btn").click();
    await expectSent(page, { type: "launch", repo: "Owner/DCS-SRS", id: "srs-server" });

    // Host replied running:true → the row now shows Running + a Stop button.
    await expect(srs.getByTestId("entrypoint-running")).toBeVisible();
    await expect(srs.getByTestId("stop-btn")).toBeVisible();
    await expect(srs.getByTestId("launch-btn")).toHaveCount(0);

    await srs.getByTestId("stop-btn").click();
    await expectSent(page, { type: "stop", repo: "Owner/DCS-SRS", id: "srs-server" });

    // Host replied running:false → back to a Launch button.
    await expect(srs.getByTestId("launch-btn")).toBeVisible();
    await expect(srs.getByTestId("stop-btn")).toHaveCount(0);
    await expect(srs.getByTestId("entrypoint-running")).toHaveCount(0);
  });

  test("a failed launch surfaces the error inline and stays stopped", async ({ page }) => {
    await openPreview(page, "mymods");
    const broken = page.locator('[data-ep="Owner/DCS-SRS::broken"]');

    await broken.getByTestId("launch-btn").click();
    await expect(broken.getByTestId("entrypoint-error")).toBeVisible();
    await expect(broken.getByTestId("entrypoint-error")).toContainText("Executable not found");
    // Still stopped — the failed launch left a Launch button, no Stop.
    await expect(broken.getByTestId("launch-btn")).toBeVisible();
    await expect(broken.getByTestId("stop-btn")).toHaveCount(0);
  });

  test("init running-state renders a Stop button without a prior launch click", async ({ page }) => {
    await openPreview(page, "mymods");
    // Re-seed with srs-server already running (as a fresh panel would after a
    // launch that survived a reopen).
    await hostSend(page, {
      type: "init",
      dataDir: "D:\\d",
      uninstallBat: "D:\\d\\uninstall-all.bat",
      running: { "Owner/DCS-SRS::srs-server": true },
      mods: [
        {
          repo: "Owner/DCS-SRS",
          name: "DCS-SRS",
          tag: "v1.0.0",
          enabled: true,
          dir: "D:\\d\\Owner__DCS-SRS",
          links: 1,
          entrypoints: [{ id: "srs-server", name: "SRS Server", exe: "Server/SR-Server.exe" }],
        },
      ],
    });
    const srs = page.locator('[data-ep="Owner/DCS-SRS::srs-server"]');
    await expect(srs.getByTestId("stop-btn")).toBeVisible();
    await expect(srs.getByTestId("entrypoint-running")).toBeVisible();
  });
});

test.describe("My Mods — install manifest breakdown (#12)", () => {
  const srs = (page: import("@playwright/test").Page) =>
    page.locator('[data-testid="mod-manifest"][data-repo="Owner/DCS-SRS"]');

  test("a privileged installed mod shows risk badges, symlinks, executables and mission scripts", async ({ page }) => {
    const errors = await openPreview(page, "mymods");
    const m = srs(page);
    await expect(m).toBeVisible();
    await expect(m.getByTestId("mod-risk-badge")).toHaveCount(3);
    await expect(m.getByTestId("mod-symlinks")).toBeVisible();
    await expect(m.getByTestId("mod-executables")).toBeVisible();
    await expect(m.getByTestId("mod-mission-scripts")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a before-sanitize script surfaces the notice + badge, and the row is tagged", async ({ page }) => {
    await openPreview(page, "mymods");
    const m = srs(page);
    await expect(m.getByTestId("mod-sanitize-notice")).toBeVisible();
    await expect(m.getByTestId("mod-before-sanitize-badge")).toContainText("1 before-sanitize");
    await expect(m.locator('[data-testid="mod-mission-script"][data-run="before-sanitize"]')).toHaveCount(1);
  });

  test('the notice "Learn more" posts openDocs for the sandbox page', async ({ page }) => {
    await openPreview(page, "mymods");
    await srs(page).getByTestId("mod-sanitize-learn-more").click();
    await expectSent(page, { type: "openDocs", page: "sandbox" });
  });

  test("the breakdown renders for a DISABLED mod too (independent of Launch/Stop rows)", async ({ page }) => {
    await openPreview(page, "mymods");
    const disabled = page.locator('[data-testid="mod-manifest"][data-repo="Owner/Disabled-Mod"]');
    await expect(disabled).toBeVisible();
    await expect(disabled.getByTestId("mod-executables")).toBeVisible();
    // Disabled mod shows no Launch/Stop entrypoint rows, but still its breakdown:
    // only the enabled DCS-SRS mod renders an entrypoints (Launch/Stop) block.
    await expect(page.getByTestId("entrypoints")).toHaveCount(1);
  });

  test("a benign mod shows only the links-files risk and no notice", async ({ page }) => {
    await openPreview(page, "mymods");
    const plain = page.locator('[data-testid="mod-manifest"][data-repo="Owner/Plain-Mod"]');
    await expect(plain.getByTestId("mod-risk-badge")).toHaveCount(1);
    await expect(plain.locator('[data-testid="mod-risk-badge"][data-risk="links-files"]')).toBeVisible();
    await expect(plain.getByTestId("mod-sanitize-notice")).toHaveCount(0);
  });
});
