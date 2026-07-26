import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview } from "./helpers";

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
  test("renders one row per entry with time/level/subsystem/message, mine rows highlighted", async ({
    page,
  }) => {
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

  test("continuation lines are hidden together with a filtered-out parent (inherit its visibility)", async ({
    page,
  }) => {
    await openPreview(page, "log");
    await page.locator('[data-testid="level-chip"][data-level="ERROR"]').click();
    const boom = page.locator('[data-testid="log-row"][data-seq="3"]');
    await expect(boom).toBeHidden();
    await expect(boom.locator(".cont-line")).toHaveCount(2); // still in the DOM, just hidden with the wrapper
  });

  test("mine-toggle isolates rows matching the current mod, and is hidden with no mod identity", async ({
    page,
  }) => {
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

  test("text filter matches a substring, /regex/ matches a pattern, and an invalid regex is flagged without hiding rows", async ({
    page,
  }) => {
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

  test("missing-file state shows the hint pane and Open Settings posts openSettings; resolves back to the grid", async ({
    page,
  }) => {
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

    await hostSend(page, {
      type: "fileState",
      state: "ok",
      file: "C:\\Users\\test\\Saved Games\\DCS\\Logs\\dcs.log",
    });
    await expect(page.getByTestId("missing-pane")).toBeHidden();
    await expect(page.getByTestId("log-grid")).toBeVisible();
  });

  test("autoscroll pill appears once scrolled up and new lines arrive; clicking it jumps to the bottom", async ({
    page,
  }) => {
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
      entries: [
        {
          seq: 300,
          time: null,
          level: "INFO",
          subsystem: "filler",
          thread: null,
          message: "brand new line",
          mine: false,
          cont: [],
        },
      ],
      cont: [],
      dropped: 0,
    });
    await expect(page.getByTestId("autoscroll-pill")).toBeVisible();
    await expect(page.getByTestId("autoscroll-pill")).toHaveText("↓ 1 new");

    await page.getByTestId("autoscroll-pill").click();
    await expect(page.getByTestId("autoscroll-pill")).toBeHidden();
    const atBottom = await grid.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4,
    );
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

test.describe("DCS Log — sparse and bulk input", () => {
  test("an entry missing level, subsystem, cont and a dated time still renders", async ({
    page,
  }) => {
    // DCS writes plenty of lines the parser can only partially classify; a
    // half-parsed line must still reach the grid rather than be dropped.
    const errors = await openPreview(page, "log");
    await hostSend(page, {
      type: "init",
      mod: { slug: "my-mod", name: "My Mod" },
      file: "C:\\dcs.log",
      state: "ok",
      entries: [{ seq: 1, time: "12:00:00.001", message: "bare line", mine: false }],
    });

    const row = page.locator('[data-testid="log-row"][data-seq="1"]');
    await expect(row.locator(".message")).toHaveText("bare line");
    await expect(row.locator(".level")).toHaveText("");
    await expect(row.locator(".subsystem")).toHaveText("");
    // A time with no date part is used as-is rather than truncated to nothing.
    await expect(row.locator(".time")).toHaveText("12:00:00.001");
    await expect(row).toHaveAttribute("data-level", "");
    expect(errors).toEqual([]);
  });

  test("an init with no entries clears the grid", async ({ page }) => {
    await openPreview(page, "log");
    await expect(page.getByTestId("log-row")).toHaveCount(5);
    await hostSend(page, { type: "init", mod: null, file: "C:\\dcs.log", state: "ok" });
    await expect(page.getByTestId("log-row")).toHaveCount(0);
    await expect(page.getByTestId("entry-count")).toHaveText("0");
  });

  test("an empty append batch changes nothing", async ({ page }) => {
    // The tailer polls on a timer, so most batches are empty; each one must not
    // disturb the count, the dropped badge or the scroll position.
    const errors = await openPreview(page, "log");
    await hostSend(page, { type: "append" });
    await expect(page.getByTestId("log-row")).toHaveCount(5);
    await expect(page.getByTestId("dropped-badge")).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("a continuation batch attaches stack lines to an entry already on screen", async ({
    page,
  }) => {
    // The tailer sees an ERROR line before the stack frames beneath it, so the
    // frames arrive in a later batch keyed by the entry's seq.
    await openPreview(page, "log");
    const boom = page.locator('[data-testid="log-row"][data-seq="3"]');
    await expect(boom.locator(".cont-line")).toHaveCount(2);

    await hostSend(page, {
      type: "append",
      entries: [],
      cont: [
        { seq: 3, cont: ["    at a.lua:1", "    at b.lua:2", "    at c.lua:3"] },
        // A seq that has already been evicted or never arrived must be ignored.
        { seq: 9999, cont: ["orphan frame"] },
      ],
      dropped: 0,
    });
    await expect(boom.locator(".cont-line")).toHaveCount(3);
    await expect(page.getByTestId("log-row")).toHaveCount(5);
  });

  test("a log restart clears the grid and marks the break", async ({ page }) => {
    // DCS truncates dcs.log on launch; without the divider the first lines of
    // the new session look like a continuation of the old one.
    await openPreview(page, "log");
    await expect(page.getByTestId("log-row")).toHaveCount(5);

    await hostSend(page, { type: "reset" });
    await expect(page.getByTestId("restart-divider")).toBeVisible();
    await expect(page.getByTestId("log-row")).toHaveCount(0);
    await expect(page.getByTestId("entry-count")).toHaveText("0");
  });

  test("the grid is capped so a long session cannot grow without bound", async ({ page }) => {
    // dcs.log runs to hundreds of thousands of lines; the panel keeps the most
    // recent 5000 and drops the oldest rather than the newest.
    await openPreview(page, "log");
    await page.evaluate(() => {
      const entries = Array.from({ length: 5200 }, (_, i) => ({
        seq: 1000 + i,
        time: "2026-07-13 12:02:00.000",
        level: "INFO",
        subsystem: "flood",
        thread: "Main",
        message: `flood ${i}`,
        mine: false,
        cont: [],
      }));
      (window as unknown as { __host: { receive(m: unknown): void } }).__host.receive({
        type: "append",
        entries,
        cont: [],
        dropped: 0,
      });
    });

    await expect(page.getByTestId("entry-count")).toHaveText("5000", { timeout: 20000 });
    await expect(page.getByTestId("log-row")).toHaveCount(5000);
    // The five seeded rows and the first floods are gone; the newest survives.
    await expect(page.locator('[data-testid="log-row"][data-seq="3"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="log-row"][data-seq="6199"]')).toHaveCount(1);
  });

  test("a missing file with no path still shows the hint pane", async ({ page }) => {
    const errors = await openPreview(page, "log");
    await hostSend(page, { type: "fileState", state: "missing" });
    await expect(page.getByTestId("missing-pane")).toBeVisible();
    await expect(page.getByTestId("missing-pane")).toContainText("");
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "log");
    await hostSend(page, null);
    await expect(page.getByTestId("log-row")).toHaveCount(5);
    expect(errors).toEqual([]);
  });
});
