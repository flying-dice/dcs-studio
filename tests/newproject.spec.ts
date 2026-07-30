import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

// New Project writes files to disk, so the panel's job is to make the target
// unambiguous before Create is reachable: the live path preview, the
// in-place-vs-new-folder choice, and the disabled button whenever either the
// name or the destination is still missing.
test.describe("newproject preview", () => {
  test("renders a tile per template with the first one preselected", async ({ page }) => {
    const errors = await openPreview(page, "newproject");

    await expect(page.getByTestId("template-tile")).toHaveCount(5);
    await expect(page.locator('[data-testid="template-tile"][data-template="blank"]')).toHaveClass(
      /selected/,
    );
    // Every tile gets a chip, including ids the panel has no bespoke icon for,
    // so a template added host-side never renders a hole in the grid.
    await expect(
      page.locator('[data-testid="template-tile"][data-template="mission"] .ico'),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("posts a boot handshake so the opening render can be re-asked for", async ({ page }) => {
    await openPreview(page, "newproject");
    await expectSent(page, { type: "ready" });
  });

  test("the handshake's answer is the whole form when the opening push was lost", async ({
    page,
  }) => {
    // The card 24 race, with the constructor's unprompted `init` withheld: this
    // page renders NOTHING until an `init` arrives, so before the handshake a
    // lost push left a blank <div id="app"> with no tile, no button and no way
    // for the user to ask again.
    const errors = await openPreview(page, "newproject", { query: { scenario: "lostinit" } });

    await expect(page.getByTestId("template-tile")).toHaveCount(5);
    await expect(page.getByTestId("location-btn")).toBeVisible();
    await page.getByTestId("name-input").fill("recovered-mod");
    await expect(page.getByTestId("path-preview")).toHaveText(
      "→ C:\\Users\\pilot\\Projects\\recovered-mod",
    );
    await expect(page.getByTestId("create-btn")).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("choosing a template moves the selection", async ({ page }) => {
    await openPreview(page, "newproject");
    await page.locator('[data-testid="template-tile"][data-template="rust-dll"]').click();

    await expect(
      page.locator('[data-testid="template-tile"][data-template="rust-dll"]'),
    ).toHaveClass(/selected/);
    await expect(
      page.locator('[data-testid="template-tile"][data-template="blank"]'),
    ).not.toHaveClass(/selected/);
  });

  test("with no folder open it asks for a location and previews the target path", async ({
    page,
  }) => {
    await openPreview(page, "newproject");

    // No workspace folder means there is no in-place option to offer.
    await expect(page.getByTestId("mode-radio")).toHaveCount(0);
    await expect(page.getByTestId("location-btn")).toBeVisible();
    // Nothing is written until both halves of the path are known.
    await expect(page.getByTestId("path-preview")).toHaveClass(/empty/);
    await expect(page.getByTestId("create-btn")).toBeDisabled();

    await page.getByTestId("name-input").fill("my-script-mod");
    await expect(page.getByTestId("path-preview")).toHaveText(
      "→ C:\\Users\\pilot\\Projects\\my-script-mod",
    );
    await expect(page.getByTestId("create-btn")).toBeEnabled();
  });

  test("an open folder defaults to bootstrapping it in place", async ({ page }) => {
    await openPreview(page, "newproject", { query: { scenario: "folder" } });

    await expect(page.getByTestId("mode-radio")).toHaveCount(2);
    await expect(page.locator('[data-testid="mode-radio"][data-mode="inplace"]')).toBeChecked();
    // In place means the destination is fixed, so there is no location to pick.
    await expect(page.getByTestId("location-btn")).toHaveCount(0);
    await expect(page.getByTestId("path-preview")).toHaveText(
      "→ C:\\Users\\pilot\\Projects\\my-open-mod",
    );
    await expect(page.getByTestId("dest-hint")).toContainText("files you already have are kept");
    await expect(page.getByTestId("create-btn")).toBeEnabled();
  });

  test("switching to a new folder brings back the location picker", async ({ page }) => {
    await openPreview(page, "newproject", { query: { scenario: "folder" } });
    await page.locator('[data-testid="mode-radio"][data-mode="newfolder"]').check();

    await expect(page.getByTestId("location-btn")).toBeVisible();
    await expect(page.getByTestId("path-preview")).toHaveText(
      "→ C:\\Users\\pilot\\Projects\\my-open-mod",
    );
    await expect(page.getByTestId("dest-hint")).toContainText("created as a new folder");

    await page.locator('[data-testid="mode-radio"][data-mode="inplace"]').check();
    await expect(page.getByTestId("location-btn")).toHaveCount(0);
  });

  test("a bare init leaves nothing selectable and Create off", async ({ page }) => {
    // The host sends this when it has no templates and no remembered location:
    // the panel must degrade to an inert form, not to "undefined" strings.
    const errors = await openPreview(page, "newproject", { query: { scenario: "bare" } });

    await expect(page.getByTestId("template-tile")).toHaveCount(0);
    await expect(page.getByTestId("name-input")).toHaveValue("");
    await expect(page.getByTestId("location-path")).toHaveClass(/placeholder/);
    await expect(page.getByTestId("location-path")).toHaveText(
      "Choose where to create the project…",
    );
    await expect(page.getByTestId("create-btn")).toBeDisabled();

    // A name alone is not a destination, so Create stays off.
    await page.getByTestId("name-input").fill("orphan");
    await expect(page.getByTestId("path-preview")).toHaveClass(/empty/);
    await expect(page.getByTestId("create-btn")).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("both location controls open the host's folder picker", async ({ page }) => {
    await openPreview(page, "newproject");

    await page.getByTestId("location-btn").click();
    await expectSent(page, { type: "browse", location: "C:\\Users\\pilot\\Projects" });
    await expect(page.getByTestId("location-path")).toHaveText("D:\\DCS Projects");

    await page.getByTestId("browse-btn").click();
    await expect
      .poll(async () => (await sentMessages(page)).filter((m) => m.type === "browse").length)
      .toBe(2);
  });

  test("the preview drops a trailing separator from the chosen location", async ({ page }) => {
    // Browsing a drive root hands back "D:\", which would otherwise render the
    // target as "D:\\name".
    await openPreview(page, "newproject");
    await hostSend(page, { type: "browsed", path: "D:\\" });
    await page.getByTestId("name-input").fill("root-mod");

    await expect(page.getByTestId("path-preview")).toHaveText("→ D:\\root-mod");
  });

  test("Create posts the template, trimmed name, location and mode", async ({ page }) => {
    await openPreview(page, "newproject");
    await page.locator('[data-testid="template-tile"][data-template="lua-hook"]').click();
    await page.getByTestId("name-input").fill("  my-hook  ");
    await page.getByTestId("create-btn").click();

    const create = (await sentMessages(page)).find((m) => m.type === "create");
    expect(create).toEqual({
      type: "create",
      template: "lua-hook",
      name: "my-hook",
      location: "C:\\Users\\pilot\\Projects",
      inPlace: false,
    });
  });

  test("Enter in the name field creates, but only once the form is complete", async ({ page }) => {
    await openPreview(page, "newproject", { query: { scenario: "bare" } });
    await page.getByTestId("name-input").fill("nowhere");
    await page.getByTestId("name-input").press("Enter");
    expect((await sentMessages(page)).filter((m) => m.type === "create")).toHaveLength(0);

    await hostSend(page, { type: "browsed", path: "D:\\DCS Projects" });
    await page.getByTestId("name-input").fill("somewhere");
    await page.getByTestId("name-input").press("Enter");
    await expectSent(page, { type: "create", name: "somewhere" });
  });

  test("the click handler refuses an incomplete form even if fired directly", async ({ page }) => {
    // Create is guarded twice — the disabled attribute and a re-check inside
    // the handler. The second guard is what stops a stale/synthetic click from
    // scaffolding into an empty path, so drive the listener past the attribute.
    await openPreview(page, "newproject", { query: { scenario: "bare" } });
    await page
      .getByTestId("create-btn")
      .dispatchEvent("click", { bubbles: true } as unknown as object);

    expect((await sentMessages(page)).filter((m) => m.type === "create")).toHaveLength(0);
  });

  test("Create shows a busy button and blocks a second submit", async ({ page }) => {
    // The fixture leaves this create unanswered, which is the window a real
    // scaffold spends writing files — and the window in which a second click
    // would scaffold the same folder twice.
    await openPreview(page, "newproject", { query: { scenario: "folder" } });
    await page.getByTestId("name-input").fill("slow-mod");
    await page.getByTestId("create-btn").click();

    await expect(page.getByTestId("create-btn")).toBeDisabled();
    await expect(page.getByTestId("create-btn")).toContainText("Creating…");
    await page.getByTestId("name-input").press("Enter");
    expect((await sentMessages(page)).filter((m) => m.type === "create")).toHaveLength(1);
  });

  test("a scaffold failure surfaces the host's message and re-arms Create", async ({ page }) => {
    await openPreview(page, "newproject");
    await page.getByTestId("name-input").fill("taken");
    await page.getByTestId("create-btn").click();

    await expect(page.getByTestId("error-note")).toContainText("already exists");
    await expect(page.getByTestId("create-btn")).toBeEnabled();

    // Editing the name is the fix for a collision, so the stale error must go
    // as soon as the user starts typing rather than after the next attempt.
    await page.getByTestId("name-input").fill("taken-2");
    await expect(page.getByTestId("error-note")).toHaveCount(0);
  });

  test("a failure with no message still says something", async ({ page }) => {
    await openPreview(page, "newproject");
    await hostSend(page, { type: "error" });
    await expect(page.getByTestId("error-note")).toHaveText("Something went wrong.");

    // Picking a different template or destination is also a retry.
    await page.locator('[data-testid="template-tile"][data-template="lua-mission"]').click();
    await expect(page.getByTestId("error-note")).toHaveCount(0);

    await hostSend(page, { type: "error", message: "disk full" });
    await hostSend(page, { type: "browsed", path: "E:\\Elsewhere" });
    await expect(page.getByTestId("error-note")).toHaveCount(0);
  });

  test("switching destination clears a stale error", async ({ page }) => {
    await openPreview(page, "newproject", { query: { scenario: "folder" } });
    await hostSend(page, { type: "error", message: "permission denied" });
    await expect(page.getByTestId("error-note")).toBeVisible();

    await page.locator('[data-testid="mode-radio"][data-mode="newfolder"]').check();
    await expect(page.getByTestId("error-note")).toHaveCount(0);
  });

  test("a successful create is told nothing and stays latched for the teardown", async ({
    page,
  }) => {
    // Success has no reply on this protocol (card 25): the host disposes the
    // panel (in place) or reloads the window (new folder), so the form's job is
    // to stay latched until it disappears rather than flick back to armed and
    // invite a second scaffold. Typing is the sharp end of that — the in-place
    // keystroke path re-evaluates the Create button, so a form that had dropped
    // its `creating` flag would re-arm right here.
    const errors = await openPreview(page, "newproject");
    await page.getByTestId("name-input").fill("done");
    await page.getByTestId("create-btn").click();

    await expect(page.getByTestId("create-btn")).toContainText("Creating…");
    await expect(page.getByTestId("error-note")).toHaveCount(0);

    await page.getByTestId("name-input").fill("done-again");
    await expect(page.getByTestId("create-btn")).toBeDisabled();
    await page.getByTestId("name-input").press("Enter");
    expect((await sentMessages(page)).filter((m) => m.type === "create")).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "newproject");
    await hostSend(page, null);
    await expect(page.getByTestId("create-btn")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
