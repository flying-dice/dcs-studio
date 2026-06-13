// E2E: Problems panel presentation — severity-then-span ordering within a
// file group, the panel-local severity filter toggles (with the
// hidden-by-filters hint), the clickable code_description link, and the
// status-bar count chips that open the panel (model/studio/lang.pds
// StatusBarCountsOpenProblems). Runs against /lab/problems, which seeds
// mixed-severity findings the real engine cannot produce today.

import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/lab/problems");
  await expect(page.getByTestId("lab-status")).toContainText("ready");
});

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("lab-toggle-panel").click();
  await expect(page.getByTestId("problems-panel")).toBeVisible();
}

test("errors sort before warnings before info, then by span", async ({
  page,
}) => {
  await openPanel(page);
  // a.lua's findings arrive info, warning, error(80), error(40); files sort
  // a.lua then b.lua. The exact ordered list pins both the severity rank
  // and the offset tiebreak (E102 at 40 before E101 at 80).
  await expect(page.getByTestId("problem-code")).toHaveText([
    "LUA-E102",
    "LUA-E101",
    "DCS-W001",
    "DCS-I001",
    "LUA-E100",
  ]);
});

test("severity filters show counts, hide findings, and name what they hide", async ({
  page,
}) => {
  await openPanel(page);
  // Each toggle carries its workspace-wide count.
  await expect(page.getByTestId("problems-filter-error")).toHaveText("3");
  await expect(page.getByTestId("problems-filter-warning")).toHaveText("1");
  await expect(page.getByTestId("problems-filter-info")).toHaveText("1");
  await expect(page.getByTestId("problem-entry")).toHaveCount(5);

  // Toggling errors off removes exactly the three error rows.
  await page.getByTestId("problems-filter-error").click();
  await expect(page.getByTestId("problem-entry")).toHaveCount(2);
  await expect(page.getByTestId("problems-panel")).not.toContainText("LUA-E");

  // With every severity off, the empty view says which filters hide what.
  await page.getByTestId("problems-filter-warning").click();
  await page.getByTestId("problems-filter-info").click();
  await expect(page.getByTestId("problem-entry")).toHaveCount(0);
  await expect(page.getByTestId("problems-filter-hint")).toHaveText(
    "5 problems hidden by filters: errors, warnings, info",
  );

  // Re-enabling a severity brings its rows straight back.
  await page.getByTestId("problems-filter-error").click();
  await expect(page.getByTestId("problem-entry")).toHaveCount(3);
});

test("a finding with a documentation URL renders its code as a link", async ({
  page,
}) => {
  await openPanel(page);
  const link = page.locator('a[data-testid="problem-code"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText("LUA-E102");
  await expect(link).toHaveAttribute("href", "https://example.com/lua-e102");
});

test("status chips show exact counts and clicking opens the panel", async ({
  page,
}) => {
  await expect(page.getByTestId("status-chip-errors")).toHaveText("3");
  await expect(page.getByTestId("status-chip-warnings")).toHaveText("1");

  // The panel starts closed; the chip is navigation, not decoration.
  await expect(page.getByTestId("problems-panel")).toHaveCount(0);
  await page.getByTestId("status-chip-errors").click();
  await expect(page.getByTestId("problems-panel")).toBeVisible();
});
