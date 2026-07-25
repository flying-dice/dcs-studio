import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

// Publish is the one panel whose buttons have irreversible consequences: Share
// creates a public GitHub repo and pushes, Release cuts a tag and uploads
// assets. So the cases that matter most here are the ones that must *stop*:
// preflight errors disabling both buttons, a malformed owner/name refusing to
// post, and the busy latch that prevents a double-publish.
test.describe("publish preview", () => {
  test("renders one row per preflight check, with its sub-items", async ({ page }) => {
    const errors = await openPreview(page, "publish", { query: { scenario: "blocked" } });

    await expect(page.getByTestId("check-row")).toHaveCount(3);
    const bundle = page.locator('[data-testid="check-row"][data-label="Bundle sources"]');
    await expect(bundle).toHaveAttribute("data-level", "error");
    await expect(bundle.getByTestId("check-detail")).toHaveText(
      "2 paths are missing — build first",
    );
    // The items are the actionable part — which paths are missing, not just how
    // many — so they must survive into the DOM rather than only the tooltip.
    await expect(page.getByTestId("check-item")).toHaveText(["bin/mymod.dll", "Scripts/init.lua"]);
    expect(errors).toEqual([]);
  });

  test("an error-level check disables Share and Release and explains why", async ({ page }) => {
    await openPreview(page, "publish", { query: { scenario: "blocked" } });

    await expect(page.getByTestId("blocked-note")).toBeVisible();
    await expect(page.getByTestId("share-btn")).toBeDisabled();
    await expect(page.getByTestId("release-btn")).toBeDisabled();
  });

  test("warnings alone do not block publishing", async ({ page }) => {
    await openPreview(page, "publish");

    await expect(page.getByTestId("check-row")).toHaveCount(3);
    await expect(page.getByTestId("blocked-note")).toHaveCount(0);
    await expect(page.getByTestId("share-btn")).toBeEnabled();
    await expect(page.getByTestId("release-btn")).toBeEnabled();
  });

  test("prefills the form from the manifest and derives the tag from its version", async ({
    page,
  }) => {
    await openPreview(page, "publish");

    await expect(page.getByTestId("repo-name-input")).toHaveValue("my-cool-mod");
    await expect(page.getByTestId("repo-desc-input")).toHaveValue("A cool DCS mod");
    await expect(page.getByTestId("rel-tag-input")).toHaveValue("v1.2.0");
    // Nothing on GitHub yet, so there is no repo to pre-fill or link to.
    await expect(page.getByTestId("rel-repo-input")).toHaveValue("");
    await expect(page.getByTestId("already-shared-note")).toHaveCount(0);
  });

  test("an unreadable manifest still offers a usable default tag", async ({ page }) => {
    // defaults.version is "" when dcs-studio.toml is missing or unparseable;
    // publishing shouldn't offer the literal tag "v".
    await openPreview(page, "publish", { query: { scenario: "bare" } });

    await expect(page.getByTestId("rel-tag-input")).toHaveValue("v0.1.0");
    await expect(page.getByTestId("check-row")).toHaveCount(0);
  });

  test("an already-shared project links its repo and pre-fills the release form", async ({
    page,
  }) => {
    await openPreview(page, "publish", { query: { scenario: "shared" } });

    await expect(page.getByTestId("already-shared-note")).toBeVisible();
    await expect(page.getByTestId("repo-link")).toHaveText("flying-dice/my-cool-mod");
    await expect(page.getByTestId("rel-repo-input")).toHaveValue("flying-dice/my-cool-mod");

    await page.getByTestId("repo-link").click();
    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/flying-dice/my-cool-mod",
    });
  });

  test("Re-check re-asks the host for preflight results", async ({ page }) => {
    await openPreview(page, "publish");
    await page.getByTestId("recheck-btn").click();
    // One post at load, one from the button — the button must actually re-run
    // the checks rather than re-render stale state.
    await expect
      .poll(async () => (await sentMessages(page)).filter((m) => m.type === "refresh").length)
      .toBe(2);
  });

  test("Share posts the trimmed name and description, and reveals the log", async ({ page }) => {
    await openPreview(page, "publish");

    await page.getByTestId("repo-name-input").fill("  spaced-mod  ");
    await page.getByTestId("repo-desc-input").fill("  padded description  ");
    await page.getByTestId("share-btn").click();

    const msgs = await sentMessages(page);
    const share = msgs.find((m) => m.type === "share");
    expect(share.opts).toEqual({ name: "spaced-mod", description: "padded description" });
    await expect(page.getByTestId("log")).toHaveClass(/show/);
  });

  test("a completed share links the new repo and seeds the release form", async ({ page }) => {
    await openPreview(page, "publish");
    await page.getByTestId("share-btn").click();

    await expect(page.getByTestId("share-result")).toBeVisible();
    await expect(page.getByTestId("share-repo-link")).toHaveText("flying-dice/my-cool-mod");
    // Carrying the repo forward is what makes step 2 one click rather than a
    // retyped owner/name.
    await expect(page.getByTestId("rel-repo-input")).toHaveValue("flying-dice/my-cool-mod");
    await expect(page.getByTestId("log")).toContainText("✓ Shared to flying-dice/my-cool-mod");

    await page.getByTestId("share-repo-link").click();
    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/flying-dice/my-cool-mod",
    });
  });

  test("a share does not overwrite a repo the user already typed", async ({ page }) => {
    await openPreview(page, "publish");
    await page.getByTestId("rel-repo-input").fill("someone-else/fork");
    await page.getByTestId("share-btn").click();

    await expect(page.getByTestId("share-result")).toBeVisible();
    await expect(page.getByTestId("rel-repo-input")).toHaveValue("someone-else/fork");
  });

  test("Release refuses a repo that is not owner/name and says so in the log", async ({ page }) => {
    await openPreview(page, "publish");
    await page.getByTestId("rel-repo-input").fill("just-a-name");
    await page.getByTestId("release-btn").click();

    await expect(page.getByTestId("log")).toContainText("✖ Enter the repo as owner/name");
    // The point of the guard: nothing may reach the host half-addressed.
    const msgs = await sentMessages(page);
    expect(msgs.filter((m) => m.type === "release")).toHaveLength(0);
  });

  // Every one of these used to reach the host, or be silently truncated to
  // something the user never typed. A release is addressed once and cannot be
  // recalled, so a half-formed target has to stop at the button.
  for (const repo of ["owner/name/extra", "/name", "owner/"]) {
    test(`Release refuses the repo "${repo}"`, async ({ page }) => {
      await openPreview(page, "publish");
      await page.getByTestId("rel-repo-input").fill(repo);
      await page.getByTestId("release-btn").click();

      await expect(page.getByTestId("log")).toContainText("✖ Enter the repo as owner/name");
      expect((await sentMessages(page)).filter((m) => m.type === "release")).toHaveLength(0);
    });
  }

  test("Release refuses an empty tag before anything is packaged", async ({ page }) => {
    // An empty tag packaged the payload under a base name ending in a bare
    // hyphen and only failed at the CLI, with the work already done.
    await openPreview(page, "publish", { query: { scenario: "shared" } });
    await page.getByTestId("rel-tag-input").fill("   ");
    await page.getByTestId("release-btn").click();

    await expect(page.getByTestId("log")).toContainText(
      "✖ Enter a tag for the release, e.g. v1.0.0.",
    );
    expect((await sentMessages(page)).filter((m) => m.type === "release")).toHaveLength(0);
  });

  test("Release posts owner, name, trimmed tag and raw notes", async ({ page }) => {
    await openPreview(page, "publish", { query: { scenario: "shared" } });

    await page.getByTestId("rel-tag-input").fill("  v2.0.0  ");
    // Notes are markdown shown verbatim on the GitHub release, so leading
    // whitespace is content and must not be trimmed away.
    await page.getByTestId("rel-notes-input").fill("  ## What changed\n- everything\n");
    await page.getByTestId("release-btn").click();

    const release = (await sentMessages(page)).find((m) => m.type === "release");
    expect(release.opts).toEqual({
      owner: "flying-dice",
      name: "my-cool-mod",
      tag: "v2.0.0",
      notes: "  ## What changed\n- everything\n",
    });
  });

  test("a published release shows its tag, assets and a link to GitHub", async ({ page }) => {
    await openPreview(page, "publish", { query: { scenario: "shared" } });
    await page.getByTestId("release-btn").click();

    await expect(page.getByTestId("release-result")).toBeVisible();
    await expect(page.getByTestId("release-tag")).toHaveText("v1.2.0");
    // Every uploaded asset is listed: a split payload that lost a volume is
    // unusable, so the user needs to see all of them.
    await expect(page.getByTestId("release-assets")).toContainText("mymod.7z.001");
    await expect(page.getByTestId("release-assets")).toContainText("mymod.7z.002");
    await expect(page.getByTestId("release-assets")).toContainText("dcs-studio.toml");

    await page.getByTestId("release-link").click();
    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/flying-dice/my-cool-mod/releases/tag/v1.2.0",
    });
  });

  test("busy latches the matching button so a publish cannot be fired twice", async ({ page }) => {
    await openPreview(page, "publish");

    await hostSend(page, { type: "busy", scope: "share", busy: true });
    await expect(page.getByTestId("share-btn")).toBeDisabled();
    await expect(page.getByTestId("share-btn")).toHaveText("Sharing…");
    // Scoped: a share in flight must not freeze the release button's label.
    await expect(page.getByTestId("release-btn")).toBeEnabled();

    await hostSend(page, { type: "busy", scope: "release", busy: true });
    await expect(page.getByTestId("release-btn")).toBeDisabled();
    await expect(page.getByTestId("release-btn")).toHaveText("Publishing…");

    await hostSend(page, { type: "busy", scope: "share", busy: false });
    await hostSend(page, { type: "busy", scope: "release", busy: false });
    await expect(page.getByTestId("share-btn")).toHaveText("Share to GitHub");
    await expect(page.getByTestId("release-btn")).toHaveText("Package & publish release");
    await expect(page.getByTestId("share-btn")).toBeEnabled();
    await expect(page.getByTestId("release-btn")).toBeEnabled();
  });

  test("host log lines stream into the log pane in order", async ({ page }) => {
    await openPreview(page, "publish");
    await hostSend(page, { type: "log", line: "→ git init" });
    await hostSend(page, { type: "log", line: "✖ remote rejected" });
    await expect(page.getByTestId("log")).toHaveText("→ git init\n✖ remote rejected");
  });

  test("no workspace folder replaces the panel with an explanation", async ({ page }) => {
    const errors = await openPreview(page, "publish", { query: { scenario: "nofolder" } });

    await expect(page.getByTestId("no-folder-note")).toBeVisible();
    await expect(page.getByTestId("share-btn")).toHaveCount(0);

    // A late busy push for a panel that has no buttons must be a no-op, not a
    // crash — the host can still have one in flight when the folder closes.
    await hostSend(page, { type: "busy", scope: "share", busy: true });
    await expect(page.getByTestId("no-folder-note")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("ignores an empty host message", async ({ page }) => {
    const errors = await openPreview(page, "publish");
    await hostSend(page, null);
    await expect(page.getByTestId("share-btn")).toBeEnabled();
    expect(errors).toEqual([]);
  });
});
