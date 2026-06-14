// E2E: the Todos panel — workspace comment tags grouped by file, in a
// plain browser: no Tauri, no DCS (model/studio/todos.pds
// SavedFileRefreshesItsTodos, TodoClickNavigatesEditor). The lab injects
// an in-memory scanner into the REAL TodoScanner store, so the grouping,
// the save-time per-file splice, and the open+jump mechanics under test
// are the production ones.

import { test, expect, labUrl } from "./_tauri";

// Must match /lab/todos's seeded files.
const ALPHA =
  '-- TODO: wire alpha gauge\nprint("alpha")\n-- цель — FIXME: refit alpha sensor\n';

test.beforeEach(async ({ page }) => {
  await page.goto(labUrl("todos"));
  await expect(page.getByTestId("lab-status")).toContainText("ready", {
    timeout: 30_000,
  });
});

test("entries render grouped by file with tag chips and counts", async ({
  page,
}) => {
  await expect(page.getByTestId("todos-count")).toHaveText("4 items");
  // Groups sorted by path; per-group counts on the headers.
  await expect(page.getByTestId("todo-group-name")).toHaveText([
    "alpha.lua",
    "beta.lua",
  ]);
  await expect(page.getByTestId("todo-group-count")).toHaveText(["2", "2"]);
  // Tag chips per entry, in path-then-line order.
  await expect(page.getByTestId("todo-tag")).toHaveText([
    "TODO",
    "FIXME",
    "TODO",
    "HACK",
  ]);
  // Row text is the content after the tag (separators stripped).
  await expect(page.getByTestId("todo-text")).toHaveText([
    "wire alpha gauge",
    "refit alpha sensor",
    "beta first pass",
    "beta workaround",
  ]);
});

test("clicking an entry opens the file and lands the caret on the tag", async ({
  page,
}) => {
  await page
    .getByTestId("todo-entry")
    .filter({ hasText: "refit alpha sensor" })
    .click();

  // The file opens in the real editor…
  await expect(page.getByTestId("lab-status")).toContainText(
    "active: alpha.lua",
  );
  // …and the caret lands exactly on the tag. The expected offset is a
  // UTF-16 index; the multibyte prefix on the FIXME line means a
  // byte-counting column would land this assertion elsewhere.
  const expected = ALPHA.indexOf("FIXME");
  const byteIndex = new TextEncoder().encode(ALPHA.slice(0, expected)).length;
  expect(byteIndex).toBeGreaterThan(expected); // fixture really discriminates
  await expect(page.getByTestId("lab-cursor")).toHaveText(
    `cursor: lab/alpha.lua:${expected}`,
    { timeout: 5_000 },
  );
});

// Feature SavedFileRefreshesItsTodos: the save-time rescan SPLICES —
// drop only the saved file's old entries, insert its fresh ones, keep
// the other file's entries untouched. Each arm kills one mutation of the
// splice: append-without-drop leaves "beta first pass" behind; wholesale
// replace loses alpha's rows; a no-op never shows "beta rewritten".
test("saving a file splices only that file's entries", async ({ page }) => {
  await expect(page.getByTestId("todos-count")).toHaveText("4 items");

  await page.getByTestId("save-beta").click();

  // B's group shows exactly its new entries…
  const betaEntries = page
    .getByTestId("todo-group")
    .filter({ has: page.getByText("beta.lua") })
    .getByTestId("todo-entry");
  await expect(betaEntries).toHaveText([/XXX\s*beta rewritten\s*1:4/]);
  // …B's stale entries are gone…
  await expect(
    page.getByTestId("todo-entry").filter({ hasText: "beta first pass" }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("todo-entry").filter({ hasText: "beta workaround" }),
  ).toHaveCount(0);
  // …and A's entries are untouched.
  await expect(page.getByTestId("todo-text")).toHaveText([
    "wire alpha gauge",
    "refit alpha sensor",
    "beta rewritten",
  ]);
  await expect(page.getByTestId("todos-count")).toHaveText("3 items");
});

test("the manual refresh button re-queries the workspace", async ({
  page,
}) => {
  await expect(page.getByTestId("todos-count")).toHaveText("4 items");

  // Mutating the workspace alone changes nothing — no scan ran.
  await page.getByTestId("grow-alpha").click();
  await expect(page.getByTestId("todos-count")).toHaveText("4 items");
  await expect(
    page.getByTestId("todo-entry").filter({ hasText: "alpha grew offline" }),
  ).toHaveCount(0);

  // The refresh button rescans and surfaces the new entry.
  await page.getByTestId("todos-refresh").click();
  await expect(
    page.getByTestId("todo-entry").filter({ hasText: "alpha grew offline" }),
  ).toHaveCount(1);
  await expect(page.getByTestId("todos-count")).toHaveText("5 items");
});
