import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

// Setup gates first run: until these four paths are right, injection, launch,
// mod installs and {SavedGames}/{GameInstall} manifest rules are all broken.
// The cases that matter are therefore the ones that tell the user a path is
// wrong *before* they save it, and the empty-detection state a first-run
// machine actually shows.
test.describe("setup preview", () => {
  test("lists detected candidates for both roots with their validity pill", async ({ page }) => {
    const errors = await openPreview(page, "setup");

    const saved = page.locator('[data-testid="cand-row"][data-pick="saved"]');
    await expect(saved).toHaveCount(2);
    await expect(saved.getByTestId("cand-name")).toHaveText(["DCS", "DCS.openbeta"]);
    await expect(saved.nth(0).getByTestId("cand-pill")).toHaveClass(/ok/);
    // A Saved Games folder with no Config has never had DCS run against it —
    // picking it silently would leave every install rule pointing nowhere.
    await expect(saved.nth(1).getByTestId("cand-pill")).toHaveClass(/warn/);
    await expect(saved.nth(1).getByTestId("cand-pill")).toHaveText("no Config yet — run DCS once");

    await expect(page.locator('[data-testid="cand-row"][data-pick="install"]')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("matches the saved path to its candidate case-insensitively", async ({ page }) => {
    // Windows paths are case-insensitive; the fixture's setting differs in case
    // from the detected folder, and the panel must still show it as chosen.
    await openPreview(page, "setup");

    const saved = page.locator('[data-testid="cand-row"][data-pick="saved"]');
    await expect(saved.nth(0)).toHaveClass(/selected/);
    await expect(saved.nth(1)).not.toHaveClass(/selected/);
    await expect(page.locator('[data-testid="validity-line"][data-which="saved"]')).toHaveText(
      "✔ has Config",
    );
  });

  test("shows no validity line for a root that is not set yet", async ({ page }) => {
    await openPreview(page, "setup");
    await expect(page.locator('[data-testid="validity-line"][data-which="install"]')).toHaveCount(
      0,
    );
    await expect(page.getByTestId("install-input")).toHaveValue("");
  });

  test("picking a candidate fills its input and warns when that folder is not ready", async ({
    page,
  }) => {
    await openPreview(page, "setup");

    await page.locator('[data-testid="cand-row"][data-pick="saved"]').nth(1).click();
    await expect(page.getByTestId("saved-input")).toHaveValue(
      "C:\\Users\\pilot\\Saved Games\\DCS.openbeta",
    );
    await expect(page.locator('[data-testid="validity-line"][data-which="saved"]')).toHaveText(
      "⚠ no Config yet — run DCS once",
    );

    await page.locator('[data-testid="cand-row"][data-pick="install"]').nth(0).click();
    await expect(page.getByTestId("install-input")).toHaveValue(
      "C:\\Program Files\\Eagle Dynamics\\DCS World",
    );
    await expect(page.locator('[data-testid="validity-line"][data-which="install"]')).toHaveText(
      "✔ has bin\\DCS.exe",
    );
  });

  test("a hand-picked path outside the detected set gets no validity claim", async ({ page }) => {
    // The panel only knows the validity of what it detected; asserting "✔" for
    // an arbitrary browsed folder would be a lie, so it says nothing.
    await openPreview(page, "setup");
    await hostSend(page, { type: "browsed", which: "saved", path: "Z:\\somewhere\\else" });

    await expect(page.getByTestId("saved-input")).toHaveValue("Z:\\somewhere\\else");
    await expect(page.locator('[data-testid="validity-line"][data-which="saved"]')).toHaveCount(0);
  });

  test("nothing detected tells the user to browse instead of showing an empty list", async ({
    page,
  }) => {
    const errors = await openPreview(page, "setup", { query: { scenario: "none" } });

    await expect(page.getByTestId("cand-empty")).toHaveCount(2);
    await expect(page.locator('[data-testid="cand-empty"][data-which="saved"]')).toBeVisible();
    await expect(page.locator('[data-testid="cand-empty"][data-which="install"]')).toBeVisible();
    await expect(page.getByTestId("cand-row")).toHaveCount(0);
    // A bare init leaves every field empty rather than rendering "undefined".
    await expect(page.getByTestId("saved-input")).toHaveValue("");
    await expect(page.getByTestId("install-input")).toHaveValue("");
    await expect(page.getByTestId("data-input")).toHaveValue("");
    await expect(page.getByTestId("sevenzip-input")).toHaveValue("");
    expect(errors).toEqual([]);
  });

  test("7-Zip status reflects whether the packer was found", async ({ page }) => {
    await openPreview(page, "setup");
    await expect(page.getByTestId("sevenzip-status")).toHaveClass(/ok/);
    await expect(page.getByTestId("sevenzip-status")).toHaveText(
      "✔ Detected: C:\\Program Files\\7-Zip\\7z.exe",
    );

    // Without 7z nothing can be packaged or unpacked, so a re-detect that no
    // longer finds it has to say so loudly on the panel that fixes it.
    await hostSend(page, { type: "init" });
    await expect(page.getByTestId("sevenzip-status")).toHaveClass(/warn/);
    await expect(page.getByTestId("sevenzip-status")).toContainText("7z not found");
  });

  test("the data dir shows the default it falls back to when left empty", async ({ page }) => {
    await openPreview(page, "setup");
    await expect(page.getByTestId("data-default")).toContainText(
      "C:\\Users\\pilot\\DCSStudio\\mods",
    );
    await expect(page.getByTestId("data-input")).toHaveAttribute(
      "placeholder",
      "C:\\Users\\pilot\\DCSStudio\\mods",
    );
  });

  test("each Browse button asks the host for its own role", async ({ page }) => {
    await openPreview(page, "setup");
    for (const which of ["saved", "install", "data", "sevenzip"]) {
      await page.locator(`[data-testid="browse-btn"][data-browse="${which}"]`).click();
      await expectSent(page, { type: "browse", which });
    }
  });

  test("a browsed folder lands in the field that asked for it", async ({ page }) => {
    await openPreview(page, "setup");

    await hostSend(page, { type: "browsed", which: "saved", path: "E:\\Saved Games\\DCS" });
    await expect(page.getByTestId("saved-input")).toHaveValue("E:\\Saved Games\\DCS");

    await hostSend(page, { type: "browsed", which: "data", path: "E:\\DCSStudio\\mods" });
    await expect(page.getByTestId("data-input")).toHaveValue("E:\\DCSStudio\\mods");

    await hostSend(page, { type: "browsed", which: "install", path: "E:\\Games\\DCS World" });
    await expect(page.getByTestId("install-input")).toHaveValue("E:\\Games\\DCS World");
  });

  test("known defect: a browsed 7z.exe lands in the DCS install field", async ({ page }) => {
    // media/setup.js routes "browsed" with an if/else-if chain whose final else
    // is the install path, so which:"sevenzip" is misrouted: the 7-Zip field is
    // left empty and the DCS install path is clobbered with an .exe. Pinned
    // here so the fix is visible when it lands — the two expectations below
    // should swap fields.
    await openPreview(page, "setup");
    await hostSend(page, { type: "browsed", which: "sevenzip", path: "E:\\Tools\\7z.exe" });

    await expect(page.getByTestId("sevenzip-input")).toHaveValue("");
    await expect(page.getByTestId("install-input")).toHaveValue("E:\\Tools\\7z.exe");
  });

  test("Re-detect re-asks the host to scan", async ({ page }) => {
    await openPreview(page, "setup", { query: { scenario: "none" } });
    await page.getByTestId("redetect-btn").click();
    await expectSent(page, { type: "redetect" });
  });

  test("Save posts all four paths, trimmed", async ({ page }) => {
    await openPreview(page, "setup", { query: { scenario: "none" } });

    await page.getByTestId("saved-input").fill("  C:\\SG\\DCS  ");
    await page.getByTestId("install-input").fill("  C:\\DCS World  ");
    await page.getByTestId("data-input").fill("  D:\\mods  ");
    await page.getByTestId("sevenzip-input").fill("  C:\\7z.exe  ");
    await page.getByTestId("save-btn").click();

    const save = (await sentMessages(page)).find((m) => m.type === "save");
    // A stray trailing space in a Windows path is invisible in the UI but
    // breaks every path join downstream, so trimming is part of the contract.
    expect(save).toEqual({
      type: "save",
      savedGames: "C:\\SG\\DCS",
      gameInstall: "C:\\DCS World",
      dataDir: "D:\\mods",
      sevenZip: "C:\\7z.exe",
    });
  });

  test("the saved acknowledgement appears and then clears itself", async ({ page }) => {
    await openPreview(page, "setup");
    await expect(page.getByTestId("saved-note")).toBeHidden();

    await page.getByTestId("save-btn").click();
    await expect(page.getByTestId("saved-note")).toBeVisible();
    // It's a transient confirmation, not a permanent badge: leaving it up would
    // suggest later unsaved edits were also persisted.
    await expect(page.getByTestId("saved-note")).toBeHidden({ timeout: 5000 });
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "setup");
    await hostSend(page, null);
    await expect(page.getByTestId("save-btn")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
