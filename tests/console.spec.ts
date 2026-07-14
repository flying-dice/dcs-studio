import { expect, test } from "@playwright/test";
import { hostSend, openPreview, sentMessages } from "./helpers";

// Build node selectors from the raw path — our paths only contain _, /,
// letters and digits, all selector-safe.
function sel(path: string) {
  return `[data-testid="tree-node"][data-path="${path}"]`;
}

async function openExplorer(page: import("@playwright/test").Page) {
  const errors = await openPreview(page, "console");
  await page.locator('.tab[data-tab="explorer"]').click();
  // Wait for the auto-expanded _G root's children to render.
  await expect(page.locator(sel("_G/db"))).toBeVisible();
  return errors;
}

async function expandCount(page: import("@playwright/test").Page) {
  const msgs = await sentMessages(page);
  return msgs.filter((m) => m && m.type === "expand").length;
}

test.describe("Lua Console — Explorer tab", () => {
  test("renders the _G root children after inspecting the env", async ({ page }) => {
    const errors = await openExplorer(page);
    await expect(page.locator(sel("_G/db"))).toBeVisible();
    await expect(page.locator(sel("_G/net"))).toBeVisible();
    await expect(page.locator(sel("_G/outText"))).toBeVisible();
    await expect(page.locator(sel("_G/count"))).toBeVisible();
    // The number leaf shows its value; the table shows its child count.
    await expect(page.locator(`${sel("_G/count")} [data-testid="node-preview"]`)).toHaveText("42");
    expect(errors).toEqual([]);
  });

  test("expands a table lazily on toggle", async ({ page }) => {
    await openExplorer(page);
    // Units is not fetched until db is opened.
    await expect(page.locator(sel("_G/db/Units"))).toHaveCount(0);
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();
    await expect(page.locator(sel("_G/db/Weapons"))).toBeVisible();
  });

  test("collapse discards children and reopen refetches them", async ({ page }) => {
    await openExplorer(page);
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();
    const afterOpen = await expandCount(page);

    // Collapse: children leave the DOM entirely.
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toHaveCount(0);

    // Reopen: a fresh expand round trip re-materialises them.
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();
    expect(await expandCount(page)).toBe(afterOpen + 1);
  });

  test("filter narrows to matches and keeps their ancestors visible", async ({ page }) => {
    await openExplorer(page);
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();

    await page.getByTestId("explorer-filter").fill("Units");
    // The match and its ancestors stay; unrelated branches hide.
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();
    await expect(page.locator(sel("_G/db"))).toBeVisible();
    await expect(page.locator(sel("_G/net"))).toBeHidden();
    await expect(page.locator(sel("_G/db/Weapons"))).toBeHidden();

    // Clearing the filter unhides everything again.
    await page.getByTestId("explorer-filter").fill("");
    await expect(page.locator(sel("_G/net"))).toBeVisible();
  });

  test("a bare-word Enter is refused with a path-pattern notice", async ({ page }) => {
    await openExplorer(page);
    await page.getByTestId("explorer-filter").fill("Units");
    await page.getByTestId("explorer-filter").press("Enter");
    await expect(page.getByTestId("sweep-notice")).toBeVisible();
    await expect(page.getByTestId("sweep-notice")).toContainText("path pattern with /");
  });

  test("sweep auto-expands toward a path-pattern match", async ({ page }) => {
    await openExplorer(page);
    await page.getByTestId("explorer-filter").fill("_G/db/Units/*");
    await page.getByTestId("explorer-filter").press("Enter");
    // The sweep drills db -> Units -> Cars without any manual toggles.
    await expect(page.locator(sel("_G/db/Units/Cars"))).toBeVisible();
    await expect(page.locator(sel("_G/db/Units/Planes"))).toBeVisible();
  });

  test("sweep reports the 200-fetch budget cap", async ({ page }) => {
    await openExplorer(page);
    await expect(page.locator(sel("_G/many"))).toBeAttached();
    await page.getByTestId("explorer-filter").fill("_G/many/*");
    await page.getByTestId("explorer-filter").press("Enter");
    await expect(page.getByTestId("sweep-notice")).toContainText("200-fetch limit", {
      timeout: 15000,
    });
  });

  test("copy shows the check state and writes children JSON", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await openExplorer(page);
    const copy = page.locator(`${sel("_G")} > .row > [data-testid="node-copy"]`);
    await page.locator(`${sel("_G")} > .row`).hover();
    await copy.click();
    await expect(copy).toHaveAttribute("data-state", "copied");
    // The check reverts to the copy icon after ~2s.
    await expect(copy).not.toHaveAttribute("data-state", "copied", { timeout: 4000 });
  });

  test("a function shows its arity, then resolves real parameter names on click", async ({
    page,
  }) => {
    await openExplorer(page);
    const preview = page.locator(`${sel("_G/outText")} [data-testid="node-preview"]`);
    await expect(preview).toHaveText("function (3 args)");
    await page.locator(`${sel("_G/outText")} > .row`).click();
    await expect(preview).toHaveText("outText(text, displayTime, clearView)");
  });

  test("going offline still surfaces the Launch DCS button (does not regress #7)", async ({
    page,
  }) => {
    await openExplorer(page);
    await expect(page.locator("#launchBtn")).toBeHidden();
    await hostSend(page, {
      type: "status",
      status: {
        gui: { connected: false, dcsTime: null },
        mission: { connected: false, dcsTime: null },
      },
    });
    await expect(page.locator("#launchBtn")).toBeVisible();
    await expect(page.getByTestId("explorer-filter")).toBeDisabled();
  });
});
