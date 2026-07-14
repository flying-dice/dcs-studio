import { expect, test } from "@playwright/test";
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
});
