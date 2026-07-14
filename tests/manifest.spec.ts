import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend, sentMessages } from "./helpers";

test.describe("manifest preview", () => {
  test("seeds the form from __BOOTSTRAP__", async ({ page }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await expect(nameInput).toHaveValue("f16-weapons-expansion");
    await expect(page.getByTestId("install-row")).toHaveCount(2);
    await expect(page.getByTestId("req-row")).toHaveCount(1);
    await expect(page.getByTestId("toml-preview")).toContainText('name = "f16-weapons-expansion"');
    // [[dependencies]] is not modeled by the form — it round-trips verbatim
    // through the extras passthrough.
    await expect(page.getByTestId("toml-preview")).toContainText("[[dependencies]]");
  });

  test("typing posts a debounced edit and updates the live TOML preview", async ({ page }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await nameInput.fill("renamed-mod");
    await expect(page.getByTestId("toml-preview")).toContainText('name = "renamed-mod"');

    // The `edit` post is debounced 200ms after the last keystroke — expectSent
    // polls, so reading __sentMessages immediately here would be a race.
    await expectSent(page, { type: "edit" });
    const messages = await sentMessages(page);
    const last = messages[messages.length - 1];
    expect(last.type).toBe("edit");
    expect(last.text).toContain('name = "renamed-mod"');
  });

  test("clearing the name shows a validation issue", async ({ page }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await nameInput.fill("");
    await expect(page.getByTestId("validation-issues")).toContainText("Project name is required.");
    await expect(page.getByTestId("validation-ok")).toHaveCount(0);
  });

  test("a valid manifest shows validation-ok", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await expect(page.getByTestId("validation-issues")).toHaveCount(0);
  });

  test("add / remove install rows", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("install-row")).toHaveCount(2);

    await page.getByTestId("add-install-btn").click();
    await expect(page.getByTestId("install-row")).toHaveCount(3);

    await page.getByTestId("install-row").last().getByTestId("remove-row-btn").click();
    await expect(page.getByTestId("install-row")).toHaveCount(2);
  });

  test("a {GameInstall} root with no configured path shows the unresolved-root warning", async ({ page }) => {
    await openPreview(page, "manifest");
    const firstRow = page.getByTestId("install-row").first();
    await firstRow.locator('select[data-key="__root"]').selectOption("{GameInstall}");
    await expect(firstRow.getByTestId("unresolved-warning")).toBeVisible();
    await expect(page.getByTestId("validation-issues")).toContainText("{GameInstall} is not configured");
  });

  test("hostSend {type: external} re-seeds the form from a new document", async ({ page }) => {
    await openPreview(page, "manifest");
    await hostSend(page, {
      type: "external",
      rawText: '[project]\nname = "from-outside"\nversion = "9.9.9"\n',
    });
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await expect(nameInput).toHaveValue("from-outside");
    await expect(page.getByTestId("install-row")).toHaveCount(0);
  });
});
