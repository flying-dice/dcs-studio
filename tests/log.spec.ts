import { test, expect } from "@playwright/test";
import { openPreview, expectSent, hostSend } from "./helpers";

function fillerEntries(startSeq: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    seq: startSeq + i,
    time: "2026-07-13 12:01:00.000",
    level: "INFO",
    subsystem: "filler",
    thread: "Main",
    message: `filler line ${i}`,
    mine: false,
    cont: [],
  }));
}

test.describe("DCS Log preview", () => {
  test("renders one row per entry with time/level/subsystem/message, mine rows highlighted", async ({ page }) => {
    const errors = await openPreview(page, "log");
    await expect(page.getByTestId("log-row")).toHaveCount(5);

    const boom = page.locator('[data-testid="log-row"][data-seq="3"]');
    await expect(boom.locator(".level")).toHaveText("ERROR");
    await expect(boom.locator(".subsystem")).toHaveText("my-mod");
    await expect(boom.locator(".message")).toHaveText("boom: nil value");
    await expect(boom).toHaveAttribute("data-mine", "1");

    const other = page.locator('[data-testid="log-row"][data-seq="2"]');
    await expect(other).toHaveAttribute("data-mine", "0");

    expect(errors).toEqual([]);
  });

  test("continuation lines render indented under their parent entry", async ({ page }) => {
    await openPreview(page, "log");
    const boom = page.locator('[data-testid="log-row"][data-seq="3"]');
    await expect(boom.locator(".cont-line")).toHaveCount(2);
    await expect(boom.locator(".cont-line").first()).toContainText("init.lua:42");
  });

  test("level chips filter rows retroactively and can be toggled back on", async ({ page }) => {
    await openPreview(page, "log");
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);

    await page.locator('[data-testid="level-chip"][data-level="WARNING"]').click();
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(4);
    await expect(page.locator('[data-testid="log-row"][data-seq="2"]')).toBeHidden();

    await page.locator('[data-testid="level-chip"][data-level="WARNING"]').click();
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);
  });

  test("continuation lines are hidden together with a filtered-out parent (inherit its visibility)", async ({ page }) => {
    await openPreview(page, "log");
    await page.locator('[data-testid="level-chip"][data-level="ERROR"]').click();
    const boom = page.locator('[data-testid="log-row"][data-seq="3"]');
    await expect(boom).toBeHidden();
    await expect(boom.locator(".cont-line")).toHaveCount(2); // still in the DOM, just hidden with the wrapper
  });

  test("mine-toggle isolates rows matching the current mod, and is hidden with no mod identity", async ({ page }) => {
    await openPreview(page, "log");
    const mineToggle = page.getByTestId("mine-toggle");
    await expect(mineToggle).toBeVisible();
    await expect(mineToggle).toHaveText("My mod: My Mod");

    await mineToggle.click();
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(3);
    for (const seq of [1, 3, 4]) {
      await expect(page.locator(`[data-testid="log-row"][data-seq="${seq}"]`)).toBeVisible();
    }
    for (const seq of [2, 5]) {
      await expect(page.locator(`[data-testid="log-row"][data-seq="${seq}"]`)).toBeHidden();
    }

    await mineToggle.click();
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);

    // No manifest / no project.name: the host sends mod:null and the toggle hides.
    await hostSend(page, { type: "mod", mod: null });
    await expect(mineToggle).toBeHidden();
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);
  });

  test("text filter matches a substring, /regex/ matches a pattern, and an invalid regex is flagged without hiding rows", async ({ page }) => {
    await openPreview(page, "log");
    const filterInput = page.getByTestId("text-filter");

    await filterInput.fill("boom");
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(1);
    await expect(page.locator('[data-testid="log-row"][data-seq="3"]')).toBeVisible();

    await filterInput.fill("/loaded|alert/");
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(2);
    await expect(page.locator('[data-testid="log-row"][data-seq="1"]')).toBeVisible();
    await expect(page.locator('[data-testid="log-row"][data-seq="5"]')).toBeVisible();

    await filterInput.fill("/[/");
    await expect(filterInput).toHaveClass(/invalid/);
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);

    await filterInput.fill("");
    await expect(filterInput).not.toHaveClass(/invalid/);
    await expect(page.locator('[data-testid="log-row"]:visible')).toHaveCount(5);
  });

  test("clear button empties the grid locally and posts clear to the host", async ({ page }) => {
    await openPreview(page, "log");
    await page.getByTestId("clear-btn").click();
    await expect(page.getByTestId("log-row")).toHaveCount(0);
    await expect(page.getByTestId("entry-count")).toHaveText("0");
    await expectSent(page, { type: "clear" });
  });

  test("missing-file state shows the hint pane and Open Settings posts openSettings; resolves back to the grid", async ({ page }) => {
    await openPreview(page, "log");
    await expect(page.getByTestId("missing-pane")).toBeHidden();
    await expect(page.getByTestId("log-grid")).toBeVisible();

    await hostSend(page, {
      type: "fileState",
      state: "missing",
      file: "C:\\Users\\test\\Saved Games\\DCS\\Logs\\dcs.log",
    });
    await expect(page.getByTestId("missing-pane")).toBeVisible();
    await expect(page.getByTestId("log-grid")).toBeHidden();
    await expect(page.getByTestId("missing-pane")).toContainText("dcs.log");

    await page.getByTestId("open-settings-btn").click();
    await expectSent(page, { type: "openSettings" });

    await hostSend(page, { type: "fileState", state: "ok", file: "C:\\Users\\test\\Saved Games\\DCS\\Logs\\dcs.log" });
    await expect(page.getByTestId("missing-pane")).toBeHidden();
    await expect(page.getByTestId("log-grid")).toBeVisible();
  });

  test("autoscroll pill appears once scrolled up and new lines arrive; clicking it jumps to the bottom", async ({ page }) => {
    await openPreview(page, "log");
    await hostSend(page, { type: "append", entries: fillerEntries(100, 80), cont: [], dropped: 0 });
    await expect(page.getByTestId("log-row")).toHaveCount(85);

    const grid = page.getByTestId("log-grid");
    await grid.evaluate((el) => {
      el.scrollTop = 0;
    });
    await grid.dispatchEvent("scroll");
    await expect(page.getByTestId("autoscroll-pill")).toBeHidden();

    await hostSend(page, {
      type: "append",
      entries: [{ seq: 300, time: null, level: "INFO", subsystem: "filler", thread: null, message: "brand new line", mine: false, cont: [] }],
      cont: [],
      dropped: 0,
    });
    await expect(page.getByTestId("autoscroll-pill")).toBeVisible();
    await expect(page.getByTestId("autoscroll-pill")).toHaveText("↓ 1 new");

    await page.getByTestId("autoscroll-pill").click();
    await expect(page.getByTestId("autoscroll-pill")).toBeHidden();
    const atBottom = await grid.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
    expect(atBottom).toBe(true);
  });

  test("a dropped count from an append batch shows the dropped badge", async ({ page }) => {
    await openPreview(page, "log");
    await expect(page.getByTestId("dropped-badge")).toBeHidden();
    await hostSend(page, { type: "append", entries: [], cont: [], dropped: 3 });
    await expect(page.getByTestId("dropped-badge")).toBeVisible();
    await expect(page.getByTestId("dropped-badge")).toHaveText("3 dropped");
  });
});
