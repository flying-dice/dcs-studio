import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

test.describe("manifest preview", () => {
  test("seeds the Bundled content / Symlinks cards only from explicit [[bundle]]/[[symlink]] blocks", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await expect(nameInput).toHaveValue("f16-weapons-expansion");
    // The fixture also carries a legacy [[install]] block (extras-passthrough
    // only, like [[dependencies]]) — it must not add rows to either card.
    await expect(page.getByTestId("bundle-row")).toHaveCount(1);
    await expect(page.getByTestId("symlink-row")).toHaveCount(1);
    await expect(page.getByTestId("req-row")).toHaveCount(1);

    const preview = page.getByTestId("toml-preview");
    await expect(preview).toContainText('name = "f16-weapons-expansion"');
    await expect(preview).toContainText("[[bundle]]");
    await expect(preview).toContainText("[[symlink]]");
    // [[install]] is unmodeled — it round-trips verbatim through the extras
    // passthrough, unchanged, and contributes no [[bundle]]/[[symlink]] content.
    await expect(preview).toContainText("[[install]]");
    await expect(preview).toContainText('source = "dist/scripts"');
    await expect(preview).toContainText('dest = "{SavedGames}/Scripts/WeaponsExpansion"');
    // [[dependencies]] is not modeled by the form either — it round-trips
    // verbatim through the same extras passthrough.
    await expect(preview).toContainText("[[dependencies]]");
  });

  test("seeds the Executables card from an [[entrypoint]] block, round-tripping args/cwd", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(1);

    const row = page.getByTestId("entrypoint-row").first();
    await expect(row.locator('[data-key="id"]')).toHaveValue("f16-tool");
    await expect(row.locator('[data-key="name"]')).toHaveValue("F16 Config Tool");
    await expect(row.locator('[data-key="exe"]')).toHaveValue("Mods/tech/F16Weapons/tool.exe");
    await expect(row.locator('[data-key="cwd"]')).toHaveValue("Mods/tech/F16Weapons");
    await expect(row.getByTestId("entrypoint-args")).toHaveValue("--quiet");

    const preview = page.getByTestId("toml-preview");
    await expect(preview).toContainText("[[entrypoint]]");
    await expect(preview).toContainText('id = "f16-tool"');
    await expect(preview).toContainText('exe = "Mods/tech/F16Weapons/tool.exe"');
    await expect(preview).toContainText('args = ["--quiet"]');
    await expect(preview).toContainText('cwd = "Mods/tech/F16Weapons"');
  });

  test("editing args (one per line) re-emits a TOML array", async ({ page }) => {
    await openPreview(page, "manifest");
    const args = page.getByTestId("entrypoint-row").first().getByTestId("entrypoint-args");
    await args.fill("--minimized\n--port 5002");
    const preview = page.getByTestId("toml-preview");
    await expect(preview).toContainText('args = ["--minimized", "--port 5002"]');
  });

  test("an entrypoint exe outside all bundled paths flags a coverage issue", async ({ page }) => {
    await openPreview(page, "manifest");
    const exe = page.getByTestId("entrypoint-row").first().locator('[data-key="exe"]');
    await exe.fill("nowhere/tool.exe");
    await expect(page.getByTestId("validation-issues")).toContainText(
      "exe is not inside any bundled path",
    );
  });

  test("add / remove entrypoint rows", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(1);

    await page.getByTestId("add-entrypoint-btn").click();
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(2);

    await page.getByTestId("entrypoint-row").last().getByTestId("remove-row-btn").click();
    await expect(page.getByTestId("entrypoint-row")).toHaveCount(1);
  });

  test("seeds the Mission scripts card from a [[mission_script]] block, round-tripping fields", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("mission-script-row")).toHaveCount(1);

    const row = page.getByTestId("mission-script-row").first();
    await expect(row.locator('[data-key="name"]')).toHaveValue("F16 Weapons init");
    await expect(row.locator('[data-key="purpose"]')).toHaveValue(
      "Registers the extra stores at mission start",
    );
    await expect(row.locator('[data-key="path"]')).toHaveValue("Mods/tech/F16Weapons/init.lua");
    await expect(row.locator('select[data-key="run_on"]')).toHaveValue("after-sanitize");
    // after-sanitize is the safe timing — no warning marker.
    await expect(row.getByTestId("before-sanitize-warning")).toHaveCount(0);

    const preview = page.getByTestId("toml-preview");
    await expect(preview).toContainText("[[mission_script]]");
    await expect(preview).toContainText('name = "F16 Weapons init"');
    await expect(preview).toContainText('path = "Mods/tech/F16Weapons/init.lua"');
    await expect(preview).toContainText('run_on = "after-sanitize"');
  });

  test("switching run_on to before-sanitize shows the security warning and re-emits", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    const row = page.getByTestId("mission-script-row").first();
    await row.locator('select[data-key="run_on"]').selectOption("before-sanitize");
    await expect(row.getByTestId("before-sanitize-warning")).toBeVisible();
    await expect(row.getByTestId("before-sanitize-warning")).toContainText("unsanitized");
    await expect(page.getByTestId("toml-preview")).toContainText('run_on = "before-sanitize"');
  });

  test("a mission script path outside all bundled paths flags a coverage issue", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    const path = page.getByTestId("mission-script-row").first().locator('[data-key="path"]');
    await path.fill("nowhere/init.lua");
    await expect(page.getByTestId("validation-issues")).toContainText(
      "path is not inside any bundled path",
    );
  });

  test("clearing a mission script name flags a validation issue", async ({ page }) => {
    await openPreview(page, "manifest");
    await page.getByTestId("mission-script-row").first().locator('[data-key="name"]').fill("");
    await expect(page.getByTestId("validation-issues")).toContainText(
      "Mission script 1: name is empty.",
    );
  });

  test("add / remove mission script rows", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("mission-script-row")).toHaveCount(1);

    await page.getByTestId("add-mission-script-btn").click();
    await expect(page.getByTestId("mission-script-row")).toHaveCount(2);

    await page.getByTestId("mission-script-row").last().getByTestId("remove-row-btn").click();
    await expect(page.getByTestId("mission-script-row")).toHaveCount(1);
  });

  test("typing posts a debounced edit and updates the live TOML preview", async ({ page }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await nameInput.fill("renamed-mod");
    await expect(page.getByTestId("toml-preview")).toContainText('name = "renamed-mod"');

    // The `edit` post is debounced 200ms after the last keystroke — expectSent
    // polls, so reading __sentMessages immediately here would be a race.
    await expectSent(page, { type: "edit" });
    const messages = await sentMessages(page);
    const last = messages[messages.length - 1];
    expect(last.type).toBe("edit");
    expect(last.text).toContain('name = "renamed-mod"');
  });

  test("a [project] written with bare TOML numbers still validates and still edits", async ({
    page,
  }) => {
    // `name = 2024` is valid TOML. Parsed as a JS number it made the validation
    // pass throw, and because that pass runs before the debounced edit is
    // queued, the form went on accepting keystrokes while writing nothing back.
    const errors = await openPreview(page, "manifest", { query: { project: "numeric" } });
    await expect(page.locator('[data-sec="project"][data-key="name"]')).toHaveValue("2024");
    await expect(page.locator('[data-sec="project"][data-key="version"]')).toHaveValue("3");
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await expect(page.getByTestId("toml-preview")).toContainText('name = "2024"');

    // The form is live, not just drawn: an edit still reaches the host.
    await page.locator('[data-sec="project"][data-key="author"]').fill("viper-drivers");
    await expectSent(page, { type: "edit" });
    const messages = await sentMessages(page);
    expect(messages[messages.length - 1].text).toContain('author = "viper-drivers"');
    expect(errors).toEqual([]);
  });

  test("clearing the name shows a validation issue", async ({ page }) => {
    await openPreview(page, "manifest");
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await nameInput.fill("");
    await expect(page.getByTestId("validation-issues")).toContainText("Project name is required.");
    await expect(page.getByTestId("validation-ok")).toHaveCount(0);
  });

  test("a valid manifest shows validation-ok", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("validation-ok")).toBeVisible();
    await expect(page.getByTestId("validation-issues")).toHaveCount(0);
  });

  test("a symlink source outside all bundled paths flags a coverage issue", async ({ page }) => {
    await openPreview(page, "manifest");
    // Point the first symlink's source at something no [[bundle]] path covers.
    const firstSymlink = page.getByTestId("symlink-row").first();
    await firstSymlink.locator('[data-key="source"]').fill("nowhere/orphan.lua");
    await expect(page.getByTestId("validation-issues")).toContainText(
      "is not inside any bundled path",
    );
  });

  test("add / remove bundle rows", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("bundle-row")).toHaveCount(1);

    await page.getByTestId("add-bundle-btn").click();
    await expect(page.getByTestId("bundle-row")).toHaveCount(2);

    await page.getByTestId("bundle-row").last().getByTestId("remove-row-btn").click();
    await expect(page.getByTestId("bundle-row")).toHaveCount(1);
  });

  test("add / remove symlink rows", async ({ page }) => {
    await openPreview(page, "manifest");
    await expect(page.getByTestId("symlink-row")).toHaveCount(1);

    await page.getByTestId("add-symlink-btn").click();
    await expect(page.getByTestId("symlink-row")).toHaveCount(2);

    await page.getByTestId("symlink-row").last().getByTestId("remove-row-btn").click();
    await expect(page.getByTestId("symlink-row")).toHaveCount(1);
  });

  test("a {GameInstall} root with no configured path shows the unresolved-root warning", async ({
    page,
  }) => {
    await openPreview(page, "manifest");
    const firstRow = page.getByTestId("symlink-row").first();
    await firstRow.locator('select[data-key="__root"]').selectOption("{GameInstall}");
    await expect(firstRow.getByTestId("unresolved-warning")).toBeVisible();
    await expect(page.getByTestId("validation-issues")).toContainText(
      "{GameInstall} is not configured",
    );
  });

  test("hostSend {type: external} re-seeds the form from a new document", async ({ page }) => {
    await openPreview(page, "manifest");
    await hostSend(page, {
      type: "external",
      rawText: '[project]\nname = "from-outside"\nversion = "9.9.9"\n',
    });
    const nameInput = page.locator('[data-sec="project"][data-key="name"]');
    await expect(nameInput).toHaveValue("from-outside");
    await expect(page.getByTestId("bundle-row")).toHaveCount(0);
    await expect(page.getByTestId("symlink-row")).toHaveCount(0);
  });

  test("an external change cancels the keystroke still inside the debounce window", async ({
    page,
  }) => {
    // The document is the source of truth: an undo, a revert or a `git checkout`
    // that lands within 200ms of a keystroke discards that keystroke. The timer
    // it armed used to fire anyway and post an `edit` built from the NEW model,
    // rewriting the just-changed file in the form's canonical formatting —
    // attributed to an edit the user had already lost (card 26).
    await openPreview(page, "manifest");
    // Both halves in one evaluate, so the race is pinned rather than timed.
    await page.evaluate(() => {
      const input = document.querySelector('[data-sec="project"][data-key="name"]') as any;
      input.value = "typed-then-lost";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (window as any).__host.receive({
        type: "external",
        rawText: '[project]\nname = "from-outside"\nversion = "9.9.9"\n',
      });
    });

    await expect(page.locator('[data-sec="project"][data-key="name"]')).toHaveValue("from-outside");
    // Well past the 200ms debounce: nothing may have been posted at all.
    await page.waitForTimeout(500);
    expect((await sentMessages(page)).filter((m) => m.type === "edit")).toEqual([]);
  });

  test("a keystroke after an external change still reaches the document", async ({ page }) => {
    // The cancellation must be of the pending timer only — the form stays live.
    await openPreview(page, "manifest");
    await hostSend(page, {
      type: "external",
      rawText: '[project]\nname = "from-outside"\nversion = "9.9.9"\n',
    });
    await page.locator('[data-sec="project"][data-key="name"]').fill("typed-after");
    await expectSent(page, { type: "edit" });
    const edits = (await sentMessages(page)).filter((m) => m.type === "edit");
    expect(edits[edits.length - 1].text).toContain('name = "typed-after"');
  });
});

test.describe("manifest — validation and host pushes", () => {
  // A manifest that trips every validation rule the form owns, plus one
  // unmodeled section and a symlink under the unconfigured {GameInstall} root.
  const EDGE_TOML = [
    "[project]",
    'name = "edge-case"',
    'version = "1.0.0"',
    "",
    "[[bundle]]",
    'path = "Mods/x"',
    "",
    "[[symlink]]",
    'source = "Mods/x/entry.lua"',
    'dest = "{GameInstall}/Mods/x/entry.lua"',
    "",
    "[[entrypoint]]",
    'id = "dup"',
    'exe = "Mods/x/a.exe"',
    "",
    "[[entrypoint]]",
    'id = "dup"',
    'exe = "Mods/x/b.exe"',
    "",
    "[[requires_module]]",
    'id = ""',
    "",
    "[[dependencies]]",
    'id = "utils/dcs-lua-common"',
    "",
  ].join("\n");

  test("names every problem it finds rather than just refusing to save", async ({ page }) => {
    await openPreview(page, "manifest");
    await hostSend(page, { type: "external", rawText: EDGE_TOML });

    const issues = page.getByTestId("validation-issues");
    // A blank module id would emit an entry that matches no DCS module.
    await expect(issues).toContainText("Required module 1: id is empty.");
    // Two entrypoints sharing an id collide in My Mods' running-process map.
    await expect(issues).toContainText('Executable 2: duplicate id "dup".');
    await expect(issues).toContainText("{GameInstall} is not configured");
  });

  test("a symlink under an unconfigured root is flagged as soon as the form draws", async ({
    page,
  }) => {
    // The warning must survive a re-render, not only appear when the root
    // dropdown is changed by hand.
    await openPreview(page, "manifest");
    await hostSend(page, { type: "external", rawText: EDGE_TOML });
    await expect(
      page.getByTestId("symlink-row").first().getByTestId("unresolved-warning"),
    ).toBeVisible();
  });

  test("the preserved-sections note counts a single section in the singular", async ({ page }) => {
    await openPreview(page, "manifest");
    // The bootstrap has two unmodeled sections.
    await expect(page.locator(".muted-card")).toContainText("2 sections");

    await hostSend(page, { type: "external", rawText: EDGE_TOML });
    await expect(page.locator(".muted-card")).toContainText("1 section the form");
  });

  test("configuring the roots clears the unresolved warning without a reload", async ({ page }) => {
    // Setup writes dcsStudio.gameInstallPath while this form is open; the host
    // pushes the new roots so the form stops warning about a path that is now
    // configured.
    await openPreview(page, "manifest");
    await hostSend(page, { type: "external", rawText: EDGE_TOML });
    await expect(page.getByTestId("unresolved-warning")).toBeVisible();

    await hostSend(page, {
      type: "roots",
      roots: { savedGames: "C:\\SG\\DCS", gameInstall: "C:\\DCS World" },
    });
    await expect(page.getByTestId("unresolved-warning")).toHaveCount(0);
    await expect(page.getByTestId("resolved-dest")).toContainText(
      "C:\\DCS World\\Mods\\x\\entry.lua",
    );
    await expect(page.getByTestId("validation-issues")).not.toContainText(
      "{GameInstall} is not configured",
    );
  });

  test("a document with no file on disk is titled by the default manifest name", async ({
    page,
  }) => {
    const errors = await openPreview(page, "manifest", { query: { target: "unsaved" } });
    await expect(page.locator("header .title")).toContainText("dcs-studio.toml");
    await expect(page.locator(".preview-head .target")).toHaveText("dcs-studio.toml");
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "manifest");
    await hostSend(page, null);
    await expect(page.getByTestId("bundle-row")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test.describe("manifest — a destination reaching outside the DCS folders (#16)", () => {
  // resolveDest returns null for two unrelated reasons, and the form must not
  // conflate them: an escaping dest is refused on every machine (fix it here),
  // an unconfigured {GameInstall} is only about this machine's settings.
  const ESCAPING = [
    "[project]",
    'name = "shady"',
    "",
    "[[bundle]]",
    'path = "payload"',
    "",
    "[[symlink]]",
    'source = "payload/evil.dll"',
    'dest = "{SavedGames}/../../Windows/System32/evil.dll"',
    "",
  ].join("\n");

  test("says the destination leaves the DCS folders instead of blaming the roots", async ({
    page,
  }) => {
    const errors = await openPreview(page, "manifest");
    await hostSend(page, { type: "external", rawText: ESCAPING });

    await expect(page.getByTestId("escaping-dest-warning")).toBeVisible();
    await expect(page.getByTestId("unresolved-warning")).toHaveCount(0);
    await expect(page.getByTestId("validation-issues")).toContainText(
      "Symlink 1: destination reaches outside the DCS folders.",
    );
    expect(errors).toEqual([]);
  });

  test("warns as the author types, not only on a full redraw", async ({ page }) => {
    // The per-keystroke update and the full render share one renderer, so the
    // warning has to appear without the row being rebuilt.
    await openPreview(page, "manifest");
    const rest = page.locator('[data-sec="symlink"][data-idx="0"][data-key="__rest"]');
    await rest.fill("../../Windows/System32/evil.dll");

    await expect(page.getByTestId("escaping-dest-warning")).toBeVisible();
    await rest.fill("Scripts/ok.lua");
    await expect(page.getByTestId("escaping-dest-warning")).toHaveCount(0);
    await expect(page.getByTestId("resolved-dest")).toContainText(
      "Saved Games\\DCS\\Scripts\\ok.lua",
    );
  });
});
