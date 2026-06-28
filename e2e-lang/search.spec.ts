// E2E: the find-in-files overlay — project-wide search grouped by file, in the
// real app over CDP (model/studio/search.pds FindInFiles, issue #68). The lab
// injects an in-memory backend into the REAL FindInFiles store, so the
// grouping, the match options, the invalid-regex hint, the truncated notice,
// keyboard navigation, and the open+jump mechanics under test are the
// production ones — no Tauri.

import { test, expect, labUrl } from "./_tauri";

// Must match /lab/search's seeded alpha.lua.
const ALPHA = "local gauge = 1\n-- наводка gauge sensor\n";

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("search"));
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("opens focused and lists matches grouped by file with counts", async ({
  page,
}) => {
  // The overlay appears with the query field focused (AC: Open the overlay).
  const input = page.getByTestId("search-input");
  await expect(input).toBeFocused();

  await input.fill("gauge");

  // Matches from every file, grouped by file, with a total match/file count.
  await expect(page.getByTestId("search-count")).toHaveText(/4 results in 2 files/);
  await expect(page.getByTestId("search-group-name")).toHaveText([
    "alpha.lua",
    "beta.lua",
  ]);
  await expect(page.getByTestId("search-group-count")).toHaveText(["2", "2"]);
  await expect(page.getByTestId("search-result")).toHaveCount(4);
});

test("match options refine the results", async ({ page }) => {
  const input = page.getByTestId("search-input");
  await input.fill("gauge");
  await expect(page.getByTestId("search-result")).toHaveCount(4);

  // Case-sensitive drops beta.lua's "Gauge".
  await page.getByTestId("search-opt-case").click();
  await expect(page.getByTestId("search-count")).toHaveText(/3 results in 2 files/);
  await expect(page.getByTestId("search-result")).toHaveCount(3);
});

test("an invalid regex shows a hint instead of results", async ({ page }) => {
  const input = page.getByTestId("search-input");
  await page.getByTestId("search-opt-regex").click();
  await input.fill("(unclosed");

  await expect(page.getByTestId("search-invalid")).toBeVisible();
  await expect(page.getByTestId("search-result")).toHaveCount(0);
});

test("clicking a result jumps the caret and keeps the overlay open", async ({
  page,
}) => {
  const input = page.getByTestId("search-input");
  await input.fill("gauge");

  await page.getByTestId("search-result").filter({ hasText: "наводка" }).click();

  // The file opens in the real editor…
  await expect(page.getByTestId("lab-status")).toContainText("active: alpha.lua");
  // …and the caret lands exactly on the match. The expected offset is a UTF-16
  // index; the multibyte prefix means a byte-counting column would miss it.
  const expected = ALPHA.indexOf("gauge", ALPHA.indexOf("наводка"));
  const byteIndex = new TextEncoder().encode(ALPHA.slice(0, expected)).length;
  expect(byteIndex).toBeGreaterThan(expected); // fixture really discriminates
  await expect(page.getByTestId("lab-cursor")).toHaveText(
    `cursor: lab/alpha.lua:${expected}`,
    { timeout: 5_000 },
  );
  // A click keeps the overlay open for continued browsing.
  await expect(page.getByTestId("search-overlay")).toBeVisible();
});

test("keyboard navigation opens the selected match and closes the overlay", async ({
  page,
}) => {
  const input = page.getByTestId("search-input");
  await input.fill("gauge");
  await expect(page.getByTestId("search-result")).toHaveCount(4);

  // First result selected by default; Down moves to alpha.lua's second match.
  await input.press("ArrowDown");
  await input.press("Enter");

  await expect(page.getByTestId("search-overlay")).toBeHidden();
  await expect(page.getByTestId("lab-status")).toContainText("active: alpha.lua");
  const expected = ALPHA.indexOf("gauge", ALPHA.indexOf("наводка"));
  await expect(page.getByTestId("lab-cursor")).toHaveText(
    `cursor: lab/alpha.lua:${expected}`,
    { timeout: 5_000 },
  );
});

test("Esc dismisses the overlay and it can be reopened", async ({ page }) => {
  const input = page.getByTestId("search-input");
  await input.fill("gauge");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-overlay")).toBeHidden();

  await page.getByTestId("open-search").click();
  await expect(page.getByTestId("search-overlay")).toBeVisible();
});

test("a query with no matches shows the empty state, not an error", async ({
  page,
}) => {
  const input = page.getByTestId("search-input");
  await input.fill("zzznotfound");
  await expect(page.getByTestId("search-empty")).toHaveText("No results");
});

test("results past the cap show the truncated notice", async ({ page }) => {
  const input = page.getByTestId("search-input");
  await input.fill("needle");

  await expect(page.getByTestId("search-truncated")).toBeVisible();
  // The lab caps at LAB_CAP = 5; the overflow is flagged, not dropped silently.
  await expect(page.getByTestId("search-result")).toHaveCount(5);
});
