import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview } from "./helpers";

test.describe("docs preview", () => {
  test("renders the TOC from __DOCS__ and the first page by default", async ({ page }) => {
    await openPreview(page, "docs");
    // media/docs-content.js currently defines 15 pages across 4 sections
    // (includes the #12 "Scripting Sandbox & Trust" explainer and the
    // "DCS Unit Database" tools page).
    await expect(page.getByTestId("toc-link")).toHaveCount(15);
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");
    await expect(page.getByTestId("page-body")).not.toBeEmpty();
  });

  test("the sandbox explainer page (#12) renders its content", async ({ page }) => {
    await openPreview(page, "docs");
    await page.locator('[data-testid="toc-link"][data-page="sandbox"]').click();
    await expect(page.getByTestId("page-title")).toHaveText("Scripting Sandbox & Trust");
    await expect(page.getByTestId("page-body")).toContainText("before-sanitize");
  });

  test("TOC navigation switches the active page", async ({ page }) => {
    await openPreview(page, "docs");
    await page.locator('[data-testid="toc-link"][data-page="finding-mods"]').click();
    await expect(page.getByTestId("page-title")).toHaveText("Finding Mods");
    await expect(page.locator('[data-testid="toc-link"][data-page="finding-mods"]')).toHaveClass(
      /active/,
    );
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

  test("a deep link from the host opens on that page", async ({ page }) => {
    // Commands like "explain the sandbox" open the panel already on the right
    // page; landing on Welcome instead would make the link useless.
    await openPreview(page, "docs", { query: { page: "sandbox" } });
    await expect(page.getByTestId("page-title")).toHaveText("Scripting Sandbox & Trust");
  });

  test("a deep link to a page that no longer exists falls back to the first page", async ({
    page,
  }) => {
    await openPreview(page, "docs", { query: { page: "renamed-away" } });
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");
  });

  test("a reopened panel resumes on the page it was left on", async ({ page }) => {
    await openPreview(page, "docs", { state: { page: "publishing" } });
    await expect(page.getByTestId("page-title")).toHaveText("Publishing Your Mod");
  });

  test("a stored page that no longer exists falls back to the first page", async ({ page }) => {
    await openPreview(page, "docs", { state: { page: "deleted-page" } });
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");
  });

  test("an unknown goto target falls back to the first page rather than blanking", async ({
    page,
  }) => {
    await openPreview(page, "docs");
    await hostSend(page, { type: "goto", page: "no-such-page" });
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");
  });

  test("the last page offers Previous but no Next", async ({ page }) => {
    await openPreview(page, "docs");
    const links = page.getByTestId("toc-link");
    await links.nth((await links.count()) - 1).click();

    await expect(page.getByTestId("pager-prev")).toBeVisible();
    await expect(page.getByTestId("pager-next")).toHaveCount(0);
  });

  test("a single-page manual shows no pager at all", async ({ page }) => {
    await openPreview(page, "docs", { query: { docs: "single" } });
    await expect(page.getByTestId("page-title")).toHaveText("Only Page");
    await expect(page.locator(".pager")).toHaveCount(0);
  });

  test("no content at all renders an empty shell instead of throwing", async ({ page }) => {
    // docs-content.js is a separate script tag; if it fails to load, the panel
    // has to come up empty rather than take the webview down with it.
    const errors = await openPreview(page, "docs", { query: { docs: "empty" } });
    await expect(page.getByTestId("toc")).toBeVisible();
    await expect(page.getByTestId("toc-link")).toHaveCount(0);
    await expect(page.getByTestId("page-title")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a page whose section cannot be found still renders", async ({ page }) => {
    // The section kicker is looked up from the content rather than stored on
    // the page, so malformed content must degrade to a missing kicker, not a
    // crashed panel.
    const errors = await openPreview(page, "docs", { query: { docs: "orphan" } });
    await expect(page.getByTestId("page-title")).toHaveText("Page A");
    await expect(page.locator(".page-inner > .kicker")).toHaveText("");
    await expect(page.locator(".lede")).toHaveText("With a lede.");

    // Page B has no lede at all — the paragraph must be omitted, not empty.
    await page.getByTestId("pager-next").click();
    await expect(page.getByTestId("page-title")).toHaveText("Page B");
    await expect(page.locator(".lede")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
