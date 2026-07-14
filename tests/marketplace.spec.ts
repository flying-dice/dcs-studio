import { expect, test } from "@playwright/test";
import { expectSent, hostSend, openPreview } from "./helpers";

test.describe("marketplace preview", () => {
  test("boots by posting ready and shows the sign-in wall", async ({ page }) => {
    await openPreview(page, "marketplace");
    await expectSent(page, { type: "ready" });
    await expect(page.getByTestId("signin-wall")).toBeVisible();
  });

  test("browse-anon-btn loads all 12 fixture listings", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
  });

  test("search filters by name/description/label, empty results show list-empty", async ({
    page,
  }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await page.getByTestId("search-input").fill("kneeboard");
    await expect(page.getByTestId("mod-card")).toHaveCount(1);
    await expect(page.getByTestId("card-title")).toHaveText("Dynamic Kneeboards");

    await page.getByTestId("search-input").fill("nonexistent-mod-xyz");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await expect(page.getByTestId("mod-card")).toHaveCount(0);
  });

  test("tag filter narrows the grid", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await page.getByTestId("tag-select").selectOption("naval");
    await expect(page.getByTestId("mod-card")).toHaveCount(1);
    await expect(page.getByTestId("card-title")).toHaveText("Supercarrier Plus");
  });

  test("sort switches between most-stars and name order", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    // Default sort is "stars" — MOOSE Lite has the most (1203).
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText(
      "MOOSE Lite",
    );

    await page.getByTestId("sort-select").selectOption("name");
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText(
      "BFM Trainer",
    );
  });

  test("opening a product shows its install manifest, requirements and readme", async ({
    page,
  }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="mission-makers/operation-eastern-storm"]')
      .getByTestId("card-title")
      .click();

    await expect(page.getByTestId("product-title")).toHaveText("Operation Eastern Storm");
    await expect(page.getByTestId("install-manifest")).toBeVisible();
    await expect(page.getByTestId("section-symlinks")).toBeVisible();
    await expect(page.getByTestId("requires-card")).toBeVisible();
    await expect(page.getByTestId("readme")).toContainText("Operation Eastern Storm");
  });

  test("full install lifecycle: progress -> installed -> uninstall", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="viper-drivers/f16-weapons-expansion"]')
      .getByTestId("card-title")
      .click();
    await expect(page.getByTestId("product-title")).toHaveText("F-16C Weapons Expansion");

    await page.getByTestId("install-btn").click();
    await expectSent(page, { type: "install", repo: "viper-drivers/f16-weapons-expansion" });
    await expect(page.getByTestId("install-progress")).toBeVisible();
    await expect(page.getByTestId("installed-row")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("uninstall-btn").click();
    await expectSent(page, { type: "uninstall", repo: "viper-drivers/f16-weapons-expansion" });
    await expect(page.getByTestId("install-btn")).toBeVisible({ timeout: 5000 });
  });

  test("listings:error shows list-error", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await hostSend(page, { type: "listings:error", message: "GitHub rate limit exceeded." });
    await expect(page.getByTestId("list-error")).toContainText("GitHub rate limit exceeded.");
  });

  test("installError shows install-error on the product page", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="viper-drivers/f16-weapons-expansion"]')
      .getByTestId("card-title")
      .click();
    await expect(page.getByTestId("product-title")).toBeVisible();

    await hostSend(page, {
      type: "installError",
      repo: "viper-drivers/f16-weapons-expansion",
      message: "Download failed: network error.",
    });
    await expect(page.getByTestId("install-error")).toContainText(
      "Download failed: network error.",
    );
  });
});

// Open a product by repo id after browsing anon (shared setup for the #12 tests).
async function openProduct(page: import("@playwright/test").Page, repo: string): Promise<void> {
  await openPreview(page, "marketplace");
  await page.getByTestId("browse-anon-btn").click();
  await page
    .locator(`[data-testid="mod-card"][data-repo="${repo}"]`)
    .getByTestId("card-title")
    .click();
  await expect(page.getByTestId("product-title")).toBeVisible();
}

test.describe("marketplace — install manifest transparency (#12)", () => {
  const PRIVILEGED = "viper-drivers/f16-weapons-expansion";

  test("privileged mod shows all three risk badges before the install action", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("risk-summary")).toBeVisible();
    await expect(page.getByTestId("risk-badge")).toHaveCount(3);
    await expect(page.locator('[data-testid="risk-badge"][data-risk="links-files"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="risk-badge"][data-risk="runs-executable"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="risk-badge"][data-risk="pre-sanitize-script"]'),
    ).toBeVisible();
  });

  test("enumerates bundled content, symlinks, executables and mission scripts", async ({
    page,
  }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("section-bundles")).toBeVisible();
    await expect(page.getByTestId("section-symlinks")).toBeVisible();
    await expect(page.getByTestId("symlink-item")).toHaveCount(2);
    await expect(page.getByTestId("section-executables")).toBeVisible();
    await expect(page.getByTestId("executable-item")).toHaveCount(1);
    await expect(page.getByTestId("section-mission-scripts")).toBeVisible();
    await expect(page.getByTestId("mission-script-item")).toHaveCount(2);
  });

  test("a privileged mod never renders without its warnings (notice + badge)", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("sanitize-notice")).toBeVisible();
    await expect(page.getByTestId("before-sanitize-badge")).toContainText("1 before-sanitize");
    // The before-sanitize row is tagged; the after-sanitize one is not.
    await expect(
      page.locator('[data-testid="mission-script-item"][data-run="before-sanitize"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId("before-sanitize-tag")).toHaveCount(1);
  });

  test('the notice "Learn more" posts openDocs for the sandbox page', async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await page.getByTestId("sanitize-learn-more").click();
    await expectSent(page, { type: "openDocs", page: "sandbox" });
  });

  test("last-release recency is shown as a trust signal", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("release-recency")).toContainText("released");
  });

  test("a benign mod (links only) shows just the links-files risk and no notice", async ({
    page,
  }) => {
    await openProduct(page, "syria-collective/syria-4k-textures");
    await expect(page.getByTestId("risk-badge")).toHaveCount(1);
    await expect(page.locator('[data-testid="risk-badge"][data-risk="links-files"]')).toBeVisible();
    await expect(page.getByTestId("sanitize-notice")).toHaveCount(0);
    await expect(page.getByTestId("section-executables")).toHaveCount(0);
  });

  test("an after-sanitize-only mod lists the mission script without a notice", async ({ page }) => {
    await openProduct(page, "dcs-scripting/moose-lite");
    await expect(page.getByTestId("section-mission-scripts")).toBeVisible();
    await expect(page.getByTestId("mission-script-item")).toHaveCount(1);
    await expect(page.getByTestId("sanitize-notice")).toHaveCount(0);
    await expect(page.getByTestId("before-sanitize-badge")).toHaveCount(0);
  });

  test("an unreadable manifest renders the explicit unknown state, not missing sections", async ({
    page,
  }) => {
    await openProduct(page, "sound-mods/immersive-cockpit-audio");
    await expect(page.getByTestId("manifest-unknown")).toBeVisible();
    await expect(page.getByTestId("install-manifest")).toHaveCount(0);
    await expect(page.getByTestId("risk-summary")).toHaveCount(0);
    // Still installable — the action is present, but the actions are unknown.
    await expect(page.getByTestId("install-btn")).toBeVisible();
  });
});
