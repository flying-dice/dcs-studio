// E2E: the project-wide find-in-files overlay, driven against the REAL app
// over CDP — no DCS (model/studio/core.pds SearchAcrossWorkspace,
// SearchResultNavigatesEditor, InvalidSearchPatternShowsHint,
// SearchCapTruncatesWithNotice). /lab/search injects an in-memory backend into
// the REAL SearchSession store, so the grouping, the case/word/regex toggles,
// the truncation notice, keyboard nav, and the open+jump mechanics under test
// are the production ones.

import type { Page } from "@playwright/test";
import { test, expect, labUrl } from "./_tauri";

// Must match /lab/search's seeded alpha.lua. Line 4 has a Cyrillic prefix so
// byte and UTF-16 offsets diverge — a click only lands on the match if columns
// count UTF-16.
const ALPHA =
  '-- alpha module\nlocal needle = 1\nprint("needle")\n-- наводка needle here\n';

async function openSearch(page: Page) {
  await page.getByTestId("open-search").click();
  await expect(page.getByTestId("search-overlay")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("search"));
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("opening the overlay focuses the query field", async ({ page }) => {
  await openSearch(page);
  await expect(page.getByTestId("search-input")).toBeFocused();
});

test("matches render grouped by file with counts and a summary", async ({
  page,
}) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("needle");

  await expect(page.getByTestId("search-summary")).toContainText(
    "5 results in 2 files",
  );
  // Groups sorted by path, with per-file counts.
  await expect(page.getByTestId("search-group-name")).toHaveText([
    "alpha.lua",
    "beta.lua",
  ]);
  await expect(page.getByTestId("search-group-count")).toHaveText(["3", "2"]);
});

test("the case-sensitive toggle re-runs the search", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("needle");
  await expect(page.getByTestId("search-summary")).toContainText(
    "5 results in 2 files",
  );

  await page.getByTestId("search-toggle-case").click();

  // Case-sensitive drops beta's "Needle"; alpha's three and beta's
  // "needleHelper" remain.
  await expect(page.getByTestId("search-summary")).toContainText(
    "4 results in 2 files",
  );
  await expect(page.getByTestId("search-group-count")).toHaveText(["3", "1"]);
});

test("the regex toggle switches between pattern and literal matching", async ({
  page,
}) => {
  await openSearch(page);
  await page.getByTestId("search-toggle-regex").click();
  await page.getByTestId("search-input").fill("n..dle");

  // As a pattern, "n..dle" matches every "needle".
  await expect(page.getByTestId("search-summary")).toContainText(
    "5 results in 2 files",
  );

  // As a literal, it matches nothing.
  await page.getByTestId("search-toggle-regex").click();
  await expect(page.getByTestId("search-empty")).toBeVisible();
});

test("an invalid regex shows an inline hint instead of results", async ({
  page,
}) => {
  await openSearch(page);
  await page.getByTestId("search-toggle-regex").click();
  await page.getByTestId("search-input").fill("(unclosed");

  await expect(page.getByTestId("search-invalid")).toBeVisible();
  await expect(page.getByTestId("search-result")).toHaveCount(0);
});

test("a query with no matches shows the empty state", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("zzzznotpresent");

  await expect(page.getByTestId("search-empty")).toBeVisible();
});

test("exceeding the cap truncates with a notice", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("dup");

  await expect(page.getByTestId("search-truncated")).toBeVisible();
  // The lab cap is 25 (the production cap is 2000).
  await expect(page.getByTestId("search-result")).toHaveCount(25);
});

test("clicking a result opens the file at the match and keeps browsing", async ({
  page,
}) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("needle");

  // Click the line-4 hit (uniquely identified by its Cyrillic prefix).
  await page
    .getByTestId("search-result")
    .filter({ hasText: "наводка" })
    .click();

  // The file opens in the real editor…
  await expect(page.getByTestId("lab-status")).toContainText(
    "active: alpha.lua",
  );
  // …the caret lands on the match (UTF-16 offset; a byte-counting column would
  // miss after the multibyte prefix)…
  const expected = ALPHA.indexOf("needle here");
  const byteIndex = new TextEncoder().encode(ALPHA.slice(0, expected)).length;
  expect(byteIndex).toBeGreaterThan(expected); // fixture really discriminates
  await expect(page.getByTestId("lab-cursor")).toHaveText(
    `cursor: lab/alpha.lua:${expected}`,
    { timeout: 5_000 },
  );
  // …and a click keeps the overlay open for continued browsing.
  await expect(page.getByTestId("search-overlay")).toBeVisible();
});

test("Enter opens the selected match and dismisses the overlay", async ({
  page,
}) => {
  await openSearch(page);
  await page.getByTestId("search-input").fill("here"); // unique to line 4
  await expect(page.getByTestId("search-result")).toHaveCount(1);

  await page.getByTestId("search-input").press("Enter");

  // The overlay closes…
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
  // …and the caret landed on the match.
  await expect(page.getByTestId("lab-cursor")).toHaveText(
    `cursor: lab/alpha.lua:${ALPHA.indexOf("here")}`,
    { timeout: 5_000 },
  );
});

test("Escape dismisses the overlay", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("search-input").press("Escape");
  await expect(page.getByTestId("search-overlay")).toHaveCount(0);
});
