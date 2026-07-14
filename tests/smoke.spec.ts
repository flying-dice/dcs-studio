import { test, expect } from "@playwright/test";
import { openPreview } from "./helpers";

const PREVIEWS = ["skills", "nav", "docs", "manifest", "marketplace", "log", "mymods"];

for (const name of PREVIEWS) {
  test.describe(`smoke: ${name}`, () => {
    test("loads, renders #app, and throws no console/page errors", async ({ page }) => {
      const errors = await openPreview(page, name);
      await expect(page.locator("#app")).not.toBeEmpty();
      expect(errors).toEqual([]);
    });
  });
}

// One representative dark-theme check (not per-view — the CSS variable
// mechanism is shared via previews/theme.css, so one pass proves the wiring).
test("dark theme: skills preview picks up prefers-color-scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const errors = await openPreview(page, "skills");
  await expect(page.locator("#app")).not.toBeEmpty();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // Dark theme's --vscode-editor-background is #1f1f1f == rgb(31, 31, 31).
  expect(bg).toBe("rgb(31, 31, 31)");
  expect(errors).toEqual([]);
});
