import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

test.describe("docs preview", () => {
  test("renders the TOC from __DOCS__ and the first page by default", async ({ page }) => {
    await openPreview(page, "docs");
    // media/docs-content.js currently defines 13 pages across 4 sections.
    await expect(page.getByTestId("toc-link")).toHaveCount(13);
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");
    await expect(page.getByTestId("page-body")).not.toBeEmpty();
  });

  test("TOC navigation switches the active page", async ({ page }) => {
    await openPreview(page, "docs");
    await page.locator('[data-testid="toc-link"][data-page="finding-mods"]').click();
    await expect(page.getByTestId("page-title")).toHaveText("Finding Mods");
    await expect(page.locator('[data-testid="toc-link"][data-page="finding-mods"]')).toHaveClass(/active/);
  });

  test("pager prev/next navigate between adjacent pages", async ({ page }) => {
    await openPreview(page, "docs");
    await page.locator('[data-testid="toc-link"][data-page="finding-mods"]').click();
    await expect(page.getByTestId("page-title")).toHaveText("Finding Mods");

    await page.getByTestId("pager-next").click();
    await expect(page.getByTestId("page-title")).toHaveText("Installing Mods");

    await page.getByTestId("pager-prev").click();
    await expect(page.getByTestId("page-title")).toHaveText("Finding Mods");
  });

  test("command-btn posts {type: run, command}", async ({ page }) => {
    await openPreview(page, "docs");
    await page.getByTestId("command-btn").first().click();
    await expectSent(page, { type: "run", command: "dcs.setup.open" });
  });

  test("external links post {type: openExternal, url}", async ({ page }) => {
    await openPreview(page, "docs");
    // docs-content.js has no external link in its current copy; exercise the
    // real delegated click handler in media/docs.js directly with a fixture
    // link rather than depending on content data.
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "https://example.com/docs";
      a.textContent = "External";
      a.id = "ext-test-link";
      document.querySelector("#page")!.appendChild(a);
    });
    await page.locator("#ext-test-link").click();
    await expectSent(page, { type: "openExternal", url: "https://example.com/docs" });
  });

  test("hostSend {type: goto} renders the target page", async ({ page }) => {
    await openPreview(page, "docs");
    await hostSend(page, { type: "goto", page: "publishing" });
    await expect(page.getByTestId("page-title")).toHaveText("Publishing Your Mod");
  });
});
