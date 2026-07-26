import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

// The Explorer tab's failure and edge paths — what the tree does when a sim
// round trip comes back empty, refuses, or dies. tests/console.spec.ts covers
// the happy path (inspect, lazy expand, filter, sweep, copy).

function sel(path: string) {
  return `[data-testid="tree-node"][data-path="${path}"]`;
}

async function openExplorer(page: import("@playwright/test").Page, scenario?: string) {
  const errors = await openPreview(page, "console", scenario ? { query: { scenario } } : undefined);
  await page.locator('.tab[data-tab="explorer"]').click();
  return errors;
}

test.describe("Lua Console — Explorer failure paths", () => {
  test("a failed _G read shows the sim's error and can be retried", async ({ page }) => {
    const errors = await openExplorer(page, "inspect-fail");

    await expect(page.locator(".tree .entry.error")).toHaveText(
      "_G — attempt to index a nil value",
    );
    // The env is left un-inspected so Refresh is a real retry rather than a
    // no-op against a tree that never loaded.
    await page.getByTestId("refresh-btn").click();
    await expect
      .poll(async () => (await sentMessages(page)).filter((m) => m.type === "inspect").length)
      .toBe(2);
    expect(errors).toEqual([]);
  });

  test("a failed expand reports it against the node instead of leaving a spinner", async ({
    page,
  }) => {
    await openExplorer(page);
    await expect(page.locator(sel("_G/broken"))).toBeVisible();
    await page.locator(`${sel("_G/broken")} > .row`).click();

    await expect(page.locator(`${sel("_G/broken")} .entry.error`)).toHaveText(
      "ref no longer valid",
    );
    // The toggle has to come back out of its loading state or the row is dead.
    await expect(page.locator(`${sel("_G/broken")} > .row .spin`)).toHaveCount(0);
  });

  test("an empty table says so rather than looking unloaded", async ({ page }) => {
    await openExplorer(page);
    await page.locator(`${sel("_G/empty")} > .row`).click();
    await expect(page.locator(`${sel("_G/empty")} .entry.hint`)).toHaveText("(empty)");
  });

  test("a value of an unrecognised type still gets a row and an icon", async ({ page }) => {
    // The RT can hand back types the icon map has no case for (userdata,
    // thread, nil); those must render as inert rows, not blank ones.
    const errors = await openExplorer(page);
    const node = page.locator(sel("_G/nothing"));
    await expect(node).toBeVisible();
    await expect(node.locator('[data-testid="node-preview"]').first()).toHaveText("nil");
    expect(errors).toEqual([]);
  });

  test("a signature that cannot be resolved says so in the preview", async ({ page }) => {
    await openExplorer(page);
    const preview = page.locator(`${sel("_G/brokenFn")} [data-testid="node-preview"]`);
    await expect(preview).toHaveText("function (1 args)");

    await page.locator(`${sel("_G/brokenFn")} > .row`).click();
    await expect(preview).toHaveText("stale ref");
    await expect(preview).toHaveClass(/sig-error/);
  });

  test("export posts the table's ref and re-arms the button when it lands", async ({ page }) => {
    await openExplorer(page);
    const button = page.locator(`${sel("_G/db")} > .row > [data-testid="node-export"]`);
    await page.locator(`${sel("_G/db")} > .row`).hover();
    await button.click();

    await expectSent(page, { type: "export", label: "_G/db" });
    await expect(button).toBeEnabled();
    // Export must not double as a toggle: the row stays collapsed.
    await expect(page.locator(sel("_G/db/Units"))).toHaveCount(0);
  });

  test("a refused export re-arms the button and explains itself", async ({ page }) => {
    await openExplorer(page);
    const button = page.locator(`${sel("_G/noexport")} > .row > [data-testid="node-export"]`);
    await page.locator(`${sel("_G/noexport")} > .row`).hover();
    await button.click();

    await expect(page.getByTestId("sweep-notice")).toContainText(
      "export failed — EACCES: permission denied",
    );
    await expect(button).toBeEnabled();
  });

  test("copy still confirms when the clipboard is unavailable", async ({ page }) => {
    // Webviews in locked-down hosts can have the clipboard API blocked; the
    // copy affordance must not throw and leave the tree wedged.
    const errors = await openExplorer(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText() {
            throw new Error("clipboard blocked");
          },
        },
      });
    });

    const copy = page.locator(`${sel("_G")} > .row > [data-testid="node-copy"]`);
    await page.locator(`${sel("_G")} > .row`).hover();
    await copy.click();
    await expect(copy).toHaveAttribute("data-state", "copied");
    expect(errors).toEqual([]);
  });

  test("copy still confirms when the clipboard write is REJECTED", async ({ page }) => {
    // The routine failure, not the exotic one: writeText resolves to a rejected
    // promise (NotAllowedError) whenever the webview is not the focused
    // document. A try/catch around the call never sees it, so it used to land
    // in the console as an unhandled rejection.
    const errors = await openExplorer(page);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")),
        },
      });
    });

    const copy = page.locator(`${sel("_G")} > .row > [data-testid="node-copy"]`);
    await page.locator(`${sel("_G")} > .row`).hover();
    await copy.click();
    await expect(copy).toHaveAttribute("data-state", "copied");
    // Give the rejection a turn to surface before asserting nothing did.
    await page.waitForTimeout(50);
    expect(errors).toEqual([]);
  });

  test("Refresh drops the sim-side refs and re-reads the tree", async ({ page }) => {
    await openExplorer(page);
    await expect(page.locator(sel("_G/db"))).toBeVisible();
    await page.locator(`${sel("_G/db")} > .row`).click();
    await expect(page.locator(sel("_G/db/Units"))).toBeVisible();

    await page.getByTestId("refresh-btn").click();
    await expectSent(page, { type: "clearExplorer" });
    // The tree is rebuilt from a fresh _G, so the previously opened branch is
    // collapsed again — stale refs cannot survive a refresh.
    await expect(page.locator(sel("_G/db"))).toBeVisible();
    await expect(page.locator(sel("_G/db/Units"))).toHaveCount(0);
  });

  test("Refresh is inert while the selected env's bridge is down", async ({ page }) => {
    // The button is disabled in that state, but the handler re-checks: a click
    // that slipped through would clear the tree and then be unable to re-read
    // it, leaving an empty Explorer with no way back.
    await openExplorer(page);
    await hostSend(page, {
      type: "status",
      status: {
        gui: { connected: false, dcsTime: null },
        mission: { connected: false, dcsTime: null },
      },
    });
    await expect(page.getByTestId("refresh-btn")).toBeDisabled();
    await page.getByTestId("refresh-btn").dispatchEvent("click");

    expect((await sentMessages(page)).filter((m) => m.type === "clearExplorer")).toHaveLength(0);
  });

  test("the mission env is disabled while only the GUI bridge is up", async ({ page }) => {
    // Each env is gated on its own bridge: the GUI bridge answering says
    // nothing about whether a mission is running.
    await openExplorer(page);
    await expect(page.getByTestId("explorer-filter")).toBeEnabled();

    await page.getByTestId("env-select").selectOption("mission");
    await expect(page.getByTestId("explorer-filter")).toBeDisabled();
    await expect(page.getByTestId("refresh-btn")).toBeDisabled();

    await hostSend(page, {
      type: "status",
      status: { gui: { connected: true, dcsTime: 10 }, mission: { connected: true, dcsTime: 3 } },
    });
    await expect(page.getByTestId("explorer-filter")).toBeEnabled();
  });
});
