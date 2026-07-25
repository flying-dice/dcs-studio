import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview } from "./helpers";

test.describe("My Mods — entrypoints", () => {
  test("shows entrypoint rows only for enabled mods that declare them", async ({ page }) => {
    const errors = await openPreview(page, "mymods");
    // Only enabled mods that declare entrypoints render a Launch/Stop block:
    // DCS-SRS (2 rows) and Risky Mod (1). The disabled mod's entrypoint, the
    // mod with no entrypoints key and the plain enabled mod are all excluded.
    await expect(page.getByTestId("entrypoints")).toHaveCount(2);
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(3);

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

  test("init running-state renders a Stop button without a prior launch click", async ({
    page,
  }) => {
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
          linkCount: 1,
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

  test("a privileged installed mod shows risk badges, symlinks, executables and mission scripts", async ({
    page,
  }) => {
    const errors = await openPreview(page, "mymods");
    const m = srs(page);
    await expect(m).toBeVisible();
    await expect(m.getByTestId("mod-risk-badge")).toHaveCount(3);
    await expect(m.getByTestId("mod-symlinks")).toBeVisible();
    await expect(m.getByTestId("mod-executables")).toBeVisible();
    await expect(m.getByTestId("mod-mission-scripts")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a before-sanitize script surfaces the notice + badge, and the row is tagged", async ({
    page,
  }) => {
    await openPreview(page, "mymods");
    const m = srs(page);
    await expect(m.getByTestId("mod-sanitize-notice")).toBeVisible();
    await expect(m.getByTestId("mod-before-sanitize-badge")).toContainText("1 before-sanitize");
    await expect(
      m.locator('[data-testid="mod-mission-script"][data-run="before-sanitize"]'),
    ).toHaveCount(1);
  });

  test('the notice "Learn more" posts openDocs for the sandbox page', async ({ page }) => {
    await openPreview(page, "mymods");
    await srs(page).getByTestId("mod-sanitize-learn-more").click();
    await expectSent(page, { type: "openDocs", page: "sandbox" });
  });

  test("the breakdown renders for a DISABLED mod too (independent of Launch/Stop rows)", async ({
    page,
  }) => {
    await openPreview(page, "mymods");
    const disabled = page.locator('[data-testid="mod-manifest"][data-repo="Owner/Disabled-Mod"]');
    await expect(disabled).toBeVisible();
    await expect(disabled.getByTestId("mod-executables")).toBeVisible();
    // Disabled mod shows no Launch/Stop entrypoint rows, but still its
    // breakdown: only the two enabled mods with entrypoints render a block.
    await expect(page.getByTestId("entrypoints")).toHaveCount(2);
    await expect(
      page.locator('[data-testid="entrypoints"][data-repo="Owner/Disabled-Mod"]'),
    ).toHaveCount(0);
  });

  test("a benign mod shows only the links-files risk and no notice", async ({ page }) => {
    await openPreview(page, "mymods");
    const plain = page.locator('[data-testid="mod-manifest"][data-repo="Owner/Plain-Mod"]');
    await expect(plain.getByTestId("mod-risk-badge")).toHaveCount(1);
    await expect(
      plain.locator('[data-testid="mod-risk-badge"][data-risk="links-files"]'),
    ).toBeVisible();
    await expect(plain.getByTestId("mod-sanitize-notice")).toHaveCount(0);
  });
});

test.describe("My Mods — mod actions", () => {
  const row = (page: import("@playwright/test").Page, repo: string) =>
    page.locator(`[data-testid="mod-row"][data-repo="${repo}"]`);

  test("the enable switch posts enable or disable for that mod", async ({ page }) => {
    await openPreview(page, "mymods");
    const disabled = row(page, "Owner/Disabled-Mod");
    await expect(disabled.getByTestId("links-pill")).toHaveText("disabled");

    // The checkbox itself is visually replaced by the slider, so drive it the
    // way a user does — through the label.
    await disabled.locator(".switch").click();
    await expectSent(page, { type: "enable", repo: "Owner/Disabled-Mod" });

    await row(page, "Owner/Plain-Mod").locator(".switch").click();
    await expectSent(page, { type: "disable", repo: "Owner/Plain-Mod" });
  });

  test("Update latches the row busy and shows what it is doing", async ({ page }) => {
    // Update replaces files under DCS; firing it twice, or toggling a mod
    // mid-update, is how you end up with half-linked installs.
    await openPreview(page, "mymods");
    const srs = row(page, "Owner/DCS-SRS");
    await srs.getByTestId("update-btn").click();

    await expectSent(page, { type: "update", repo: "Owner/DCS-SRS" });
    await expect(srs.getByTestId("mod-progress")).toHaveText("Updating…");
    await expect(srs.getByTestId("update-btn")).toBeDisabled();
    await expect(srs.getByTestId("uninstall-btn")).toBeDisabled();
    await expect(srs.getByTestId("enable-toggle")).toBeDisabled();
    // Other mods stay usable — busy is per repo, not global.
    await expect(row(page, "Owner/Plain-Mod").getByTestId("update-btn")).toBeEnabled();
  });

  test("the host's progress and busy pushes drive the row's state", async ({ page }) => {
    await openPreview(page, "mymods");
    const srs = row(page, "Owner/DCS-SRS");

    await hostSend(page, { type: "busy", repo: "Owner/DCS-SRS", busy: true });
    await expect(srs.getByTestId("update-btn")).toBeDisabled();

    await hostSend(page, { type: "progress", repo: "Owner/DCS-SRS", label: "Downloading v2…" });
    await expect(srs.getByTestId("mod-progress")).toHaveText("Downloading v2…");

    // Once the host says it's done the row has to become usable again.
    await hostSend(page, { type: "busy", repo: "Owner/DCS-SRS", busy: false });
    await expect(srs.getByTestId("update-btn")).toBeEnabled();
  });

  test("Uninstall posts for that repo and latches the row", async ({ page }) => {
    await openPreview(page, "mymods");
    const srs = row(page, "Owner/DCS-SRS");
    await srs.getByTestId("uninstall-btn").click();

    await expectSent(page, { type: "uninstall", repo: "Owner/DCS-SRS" });
    // Unlike Update, Uninstall marks the row busy without re-rendering, so the
    // controls only latch once the host's own busy push arrives.
    await expect(srs.getByTestId("uninstall-btn")).toBeEnabled();
    await hostSend(page, { type: "busy", repo: "Owner/DCS-SRS", busy: true });
    await expect(srs.getByTestId("uninstall-btn")).toBeDisabled();
  });

  test("the per-mod folder and GitHub buttons address their own mod", async ({ page }) => {
    await openPreview(page, "mymods");
    await row(page, "Owner/Plain-Mod").getByTestId("open-dir-btn").click();
    await expectSent(page, { type: "openDir", repo: "Owner/Plain-Mod" });

    await row(page, "Owner/Plain-Mod").getByTestId("github-btn").click();
    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/Owner/Plain-Mod",
    });
  });

  test("the panel-level buttons post their commands", async ({ page }) => {
    await openPreview(page, "mymods");
    await page.getByTestId("shortcut-btn").click();
    await expectSent(page, { type: "createShortcut" });
    await page.getByTestId("reveal-bat-btn").click();
    await expectSent(page, { type: "revealBat" });
    await page.getByTestId("clean-uninstall-btn").click();
    await expectSent(page, { type: "cleanUninstall" });
    await page.getByTestId("refresh-btn").click();
    await expectSent(page, { type: "refresh" });
  });

  test("a mod whose manifest describes nothing renders no breakdown", async ({ page }) => {
    // A readable manifest with no bundles, links, executables or scripts has
    // nothing to disclose; an empty breakdown box would imply otherwise.
    await openPreview(page, "mymods");
    await expect(row(page, "Owner/Inert-Mod")).toBeVisible();
    await expect(
      page.locator('[data-testid="mod-manifest"][data-repo="Owner/Inert-Mod"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="entrypoints"][data-repo="Owner/Inert-Mod"]'),
    ).toHaveCount(0);
  });

  test("more than one pre-sanitize script is counted in the plural", async ({ page }) => {
    await openPreview(page, "mymods");
    const risky = page.locator('[data-testid="mod-manifest"][data-repo="Owner/Risky-Mod"]');
    await expect(risky.getByTestId("mod-sanitize-notice")).toContainText("2 scripts that run");
    await expect(risky.getByTestId("mod-before-sanitize-badge")).toContainText("2 before-sanitize");
  });

  test("an entrypoint with no display name is labelled by its id", async ({ page }) => {
    await openPreview(page, "mymods");
    await expect(page.locator('[data-ep="Owner/Risky-Mod::nameless-tool"] .ep-name')).toHaveText(
      "nameless-tool",
    );
  });

  test("an empty ledger explains itself instead of showing a bare page", async ({ page }) => {
    const errors = await openPreview(page, "mymods");
    // A first-run panel: no mods, no clean-uninstall script generated yet.
    await hostSend(page, { type: "init", dataDir: "D:\\d", mods: [] });

    await expect(page.getByTestId("mods-empty")).toBeVisible();
    await expect(page.getByTestId("mod-row")).toHaveCount(0);
    await expect(page.getByTestId("uninstall-bat-path")).toHaveText("");
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "mymods");
    await hostSend(page, null);
    await expect(page.getByTestId("mod-row")).toHaveCount(5);
    expect(errors).toEqual([]);
  });
});
