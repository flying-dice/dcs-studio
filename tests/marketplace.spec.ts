import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

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

  test("search filters by name/description/label, empty results show list-empty", async ({ page }) => {
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
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText("MOOSE Lite");

    await page.getByTestId("sort-select").selectOption("name");
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText("BFM Trainer");
  });

  test("opening a product shows its install plan, requirements and readme", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="mission-makers/operation-eastern-storm"]')
      .getByTestId("card-title")
      .click();

    await expect(page.getByTestId("product-title")).toHaveText("Operation Eastern Storm");
    await expect(page.getByTestId("install-plan")).toBeVisible();
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
    await expect(page.getByTestId("install-error")).toContainText("Download failed: network error.");
  });
});
