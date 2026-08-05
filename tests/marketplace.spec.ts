import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

/**
 * A `.empty` state's content box, measured in ONE in-page pass (issue #70).
 *
 * `waitForFunction` polls inside the browser and hands back the value it
 * settled on, so every rectangle comes from a single layout. A pair of
 * `boundingBox()` calls — or a poll followed by a second `evaluate` — can
 * straddle a re-render and read a detached node instead.
 *
 * Deliberately structure-blind: it looks for spans, not for the `<p>` wrapper
 * that fixes the bug, so broken markup fails an assertion by name rather than
 * timing out here. It does insist the element is laid out, so a state that
 * never renders times out instead of measuring as comfortably short.
 *
 * - `contentHeight` — height less `.empty`'s vertical padding, i.e. how many
 *   lines the copy actually occupies.
 * - `inlineSpread` — the baseline spread of the state's inline children. Zero
 *   when there are fewer than two; non-zero means they landed on separate rows.
 */
async function measureEmptyState(
  page: Page,
  testid: string,
): Promise<{ contentHeight: number; inlineSpread: number }> {
  const measured = await (
    await page.waitForFunction((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      // Height 0 means present but not laid out. Keep polling rather than
      // measuring it: `contentHeight` would come back NEGATIVE and sail under
      // every ceiling below, turning "never rendered" into a green test.
      if (!el || el.getBoundingClientRect().height === 0) return null;
      const tops = [...el.querySelectorAll("span")].map((s) => s.getBoundingClientRect().top);
      return {
        // 160 = `.empty`'s 80px top + 80px bottom padding (media/marketplace.css).
        // Inlined rather than passed in: this callback runs in the page and
        // cannot close over a constant declared out here.
        contentHeight: el.getBoundingClientRect().height - 160,
        inlineSpread: tops.length > 1 ? Math.max(...tops) - Math.min(...tops) : 0,
      };
    }, testid)
  ).jsonValue();
  // waitForFunction settles only on a truthy value, but its type keeps the
  // `null` the callback returns to mean "not rendered yet". Narrow it here
  // rather than with a `!`, so a genuine miss fails by name.
  if (measured === null) throw new Error(`${testid} never rendered`);
  return measured;
}

/**
 * Ceiling for a one-line `.empty` state, in px of content height.
 *
 * Measured here: one line is 17, and the smallest possible STACKED layout is
 * 46 — two line boxes plus the column's 12px `gap`. 30 sits between them with
 * room on both sides, which matters because the runners do not all have the
 * same default font: it still catches stacking if a line box shrinks to 13
 * (13+12+13 = 38), and still tolerates the copy wrapping to two lines (34 at
 * this line height, and no gap is paid for a wrap). The gap is what makes the
 * two cases separable at all — don't raise this above it.
 */
const ONE_LINE = 30;

test.describe("marketplace preview", () => {
  test("boots by posting ready and shows the sign-in wall", async ({ page }) => {
    await openPreview(page, "marketplace");
    await expectSent(page, { type: "ready" });
    await expect(page.getByTestId("signin-wall")).toBeVisible();
  });

  test("browse-anon-btn loads all 12 fixture listings", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
  });

  test("search filters by name/description/label, empty results show list-empty", async ({
    page,
  }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await page.getByTestId("search-input").fill("kneeboard");
    await expect(page.getByTestId("mod-card")).toHaveCount(1);
    await expect(page.getByTestId("card-title")).toHaveText("Dynamic Kneeboards");

    await page.getByTestId("search-input").fill("nonexistent-mod-xyz");
    await expect(page.getByTestId("list-empty")).toBeVisible();
    await expect(page.getByTestId("mod-card")).toHaveCount(0);
  });

  test("tag filter narrows the grid", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await page.getByTestId("tag-select").selectOption("naval");
    await expect(page.getByTestId("mod-card")).toHaveCount(1);
    await expect(page.getByTestId("card-title")).toHaveText("Supercarrier Plus");
  });

  test("sort switches between most-stars and name order", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    // Default sort is "stars" — MOOSE Lite has the most (1203).
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText(
      "MOOSE Lite",
    );

    await page.getByTestId("sort-select").selectOption("name");
    await expect(page.getByTestId("mod-card").first().getByTestId("card-title")).toHaveText(
      "BFM Trainer",
    );
  });

  test("opening a product shows its install manifest, requirements and readme", async ({
    page,
  }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="mission-makers/operation-eastern-storm"]')
      .getByTestId("card-title")
      .click();

    await expect(page.getByTestId("product-title")).toHaveText("Operation Eastern Storm");
    await expect(page.getByTestId("install-manifest")).toBeVisible();
    await expect(page.getByTestId("section-symlinks")).toBeVisible();
    await expect(page.getByTestId("requires-card")).toBeVisible();
    await expect(page.getByTestId("readme")).toContainText("Operation Eastern Storm");
  });

  test("full install lifecycle: progress -> installed -> uninstall", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="viper-drivers/f16-weapons-expansion"]')
      .getByTestId("card-title")
      .click();
    await expect(page.getByTestId("product-title")).toHaveText("F-16C Weapons Expansion");

    await page.getByTestId("install-btn").click();
    await expectSent(page, { type: "install", repo: "viper-drivers/f16-weapons-expansion" });
    await expect(page.getByTestId("install-progress")).toBeVisible();
    await expect(page.getByTestId("installed-row")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("uninstall-btn").click();
    await expectSent(page, { type: "uninstall", repo: "viper-drivers/f16-weapons-expansion" });
    await expect(page.getByTestId("install-btn")).toBeVisible({ timeout: 5000 });
  });

  test("listings:error shows list-error", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await hostSend(page, { type: "listings:error", message: "GitHub rate limit exceeded." });
    await expect(page.getByTestId("list-error")).toContainText("GitHub rate limit exceeded.");
  });

  test("installError shows install-error on the product page", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="viper-drivers/f16-weapons-expansion"]')
      .getByTestId("card-title")
      .click();
    await expect(page.getByTestId("product-title")).toBeVisible();

    await hostSend(page, {
      type: "installError",
      repo: "viper-drivers/f16-weapons-expansion",
      message: "Download failed: network error.",
    });
    await expect(page.getByTestId("install-error")).toContainText(
      "Download failed: network error.",
    );
  });

  test("a card's tag chip filters the grid without opening the product", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await page
      .locator('[data-testid="mod-card"][data-repo="carrier-ops/supercarrier-plus"]')
      .locator('[data-testid="card-tag"][data-tag="naval"]')
      .click();

    await expect(page.getByTestId("mod-card")).toHaveCount(1);
    // The chip sits inside a card that also opens the product on click, so it
    // has to stop the event reaching that handler.
    await expect(page.getByTestId("product-title")).toHaveCount(0);
  });

  test("a card's GitHub link opens externally without opening the product", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="utils/dcs-lua-common"]')
      .getByTestId("card-github-link")
      .click();

    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/utils/dcs-lua-common",
    });
    await expect(page.getByTestId("product-title")).toHaveCount(0);
  });

  test("Details opens the product and Back returns to the grid", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="utils/dcs-lua-common"]')
      .getByTestId("card-details-btn")
      .click();
    await expect(page.getByTestId("product-title")).toHaveText("dcs-lua-common");

    await page.getByTestId("back-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
  });

  test("View on GitHub from the product page posts the repo url", async ({ page }) => {
    await openProduct(page, "utils/dcs-lua-common");
    await page.getByTestId("view-github-btn").click();
    await expectSent(page, {
      type: "openExternal",
      url: "https://github.com/utils/dcs-lua-common",
    });
  });

  test("a product that fails to load offers a retry that reloads it", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="hoggit-liveries/usaf-aggressors"]')
      .getByTestId("card-title")
      .click();

    await expect(page.getByTestId("product-error")).toContainText("502 Bad Gateway");
    await page.getByTestId("retry-btn").click();
    await expect
      .poll(async () => (await sentMessages(page)).filter((m) => m.type === "openProduct").length)
      .toBe(2);
    // Back out of a failed product too — the error page is not a dead end.
    await page.getByTestId("back-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
  });

  test("a mod with no installable release says why instead of offering Install", async ({
    page,
  }) => {
    // A repo tagged for discovery whose latest release ships no manifest can't
    // be installed; offering the button anyway would fail at download time.
    await openProduct(page, "training/bfm-trainer");
    await expect(page.getByTestId("not-installable-note")).toContainText("Not installable");
    await expect(page.getByTestId("not-installable-note")).not.toContainText("no release yet");
    await expect(page.getByTestId("install-btn")).toHaveCount(0);

    // No release at all is a distinct, more common case and is named as such.
    await openProduct(page, "weather-systems/real-weather-injector");
    await expect(page.getByTestId("not-installable-note")).toContainText("(no release yet)");
  });

  test("a long-dormant release is dated rather than counted in months", async ({ page }) => {
    // Recency is a trust signal; "released 13 months ago" is less useful than
    // the date once a mod is over a year old.
    await openProduct(page, "utils/dcs-lua-common");
    await expect(page.getByTestId("release-recency")).toContainText(/released \d{4}-\d{2}-\d{2}/);
  });

  test("a README's markdown is rendered, not shown raw", async ({ page }) => {
    await openProduct(page, "utils/dcs-lua-common");
    const readme = page.getByTestId("readme");

    await expect(readme.locator("h1")).toHaveText("dcs-lua-common");
    await expect(readme.locator("h2")).toHaveText("Straight into a heading");
    await expect(readme.locator("ul")).toHaveCount(2);
    await expect(readme.locator("pre code")).toContainText('local vec = require("vec")');
    await expect(readme.locator("blockquote")).toContainText("Pure Lua");
    await expect(readme.locator("strong")).toHaveText("bold");
    await expect(readme.locator("em")).toHaveText("italic");
    await expect(readme.locator("code").first()).toHaveText("inline code");
    await expect(readme.locator('a[href="https://example.com/docs"]')).toHaveText("link");
  });

  test("an avatar that will not load falls back to generated initials", async ({ page }) => {
    // Author avatars come from GitHub; a dead or blocked URL must not leave a
    // broken-image glyph on every card.
    await openProduct(page, "utils/dcs-lua-common");
    const avatar = page.locator("img.avatar.lg");
    await expect(avatar).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/, {
      timeout: 5000,
    });
  });

  test("signed in without a login name still labels the session", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("who")).toHaveText("browsing as guest");

    await hostSend(page, { type: "auth", signedIn: true, browsing: false });
    await expect(page.getByTestId("who")).toHaveText("signed in");
  });

  test("an auth push with no topic keeps the one already known", async ({ page }) => {
    // The empty-grid copy names the discovery topic; losing it would leave the
    // instructions telling users to tag their repo with nothing.
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    await hostSend(page, { type: "auth", signedIn: false, browsing: true });
    await hostSend(page, { type: "listings" });

    await expect(page.getByTestId("list-empty")).toContainText("dcs-studio");
    await expect(page.getByTestId("mod-card")).toHaveCount(0);
  });

  test("the empty-grid sentence renders on one line, with its chips inline", async ({ page }) => {
    // Issue #70. `.empty` is a flex COLUMN — the product-error state stacks a
    // message over a Try-again button — so the bare text nodes and two
    // `.mono` chips that used to sit directly inside it each became their own
    // row, and the sentence shipped broken across five lines. This asserts the
    // rendered geometry rather than the copy, because the copy assertion
    // above passed the entire time the layout was wrong.
    await page.setViewportSize({ width: 1000, height: 700 });
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    // Drain the fixture's scripted replies before pushing our own. `browseAnon`
    // answers with `listings:busy` at +10ms and 12 `listings` at +500ms
    // (previews/fixtures/marketplace.js), so pushing straight after the click
    // lets the busy reply land afterwards and flip the grid to `list-loading`,
    // with the 12 listings then refilling it — and `list-empty` never returns.
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await hostSend(page, { type: "auth", signedIn: false, browsing: true });
    await hostSend(page, { type: "listings" });

    const { contentHeight, inlineSpread } = await measureEmptyState(page, "list-empty");
    // Both topic chips sit on the same baseline as the prose around them.
    expect(inlineSpread).toBeLessThan(2);
    // And the block is one line tall, not five rows plus four 12px gaps.
    expect(contentHeight).toBeLessThan(ONE_LINE);
  });

  test("the searching-GitHub spinner shares a line with its label", async ({ page }) => {
    // The same defect as #70, quieter: `.spin` is inline-block, but as a direct
    // child of the flex column it is blockified and the spinner sits on its own
    // row above the text. Coverage proves this state renders; only geometry
    // proves it renders on one line.
    await page.setViewportSize({ width: 1000, height: 700 });
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    // Empty the grid first: the spinner state needs a busy flag AND no listings
    // to fall back on, otherwise the panel keeps showing the results it has.
    await hostSend(page, { type: "listings" });
    await hostSend(page, { type: "listings:busy" });

    const { contentHeight } = await measureEmptyState(page, "list-loading");
    expect(contentHeight).toBeLessThan(ONE_LINE);
  });

  test("a product push with no manifest or requirements renders the unknown state", async ({
    page,
  }) => {
    await openProduct(page, "utils/dcs-lua-common");
    await hostSend(page, {
      type: "product",
      product: {
        repo: "utils/dcs-lua-common",
        name: "dcs-lua-common",
        author: "utils",
        repo_url: "https://github.com/utils/dcs-lua-common",
        avatar_url: "../media/icon.png",
        stars: 1,
        assets: [],
        installable: true,
      },
      installed: false,
    });

    await expect(page.getByTestId("manifest-unknown")).toBeVisible();
    await expect(page.getByTestId("requires-card")).toHaveCount(0);
    await expect(page.getByTestId("readme")).toContainText("no README");
  });

  test("a refresh re-asks the host to discover", async ({ page }) => {
    await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await page.getByTestId("refresh-btn").click();
    await expectSent(page, { type: "discover", force: true });
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    // A refresh keeps the results you were already looking at and just latches
    // the button; only a first load with nothing to show gets the spinner.
    await hostSend(page, { type: "listings:busy" });
    await expect(page.getByTestId("refresh-btn")).toBeDisabled();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await expect(page.getByTestId("list-loading")).toHaveCount(0);
  });

  test("reopening on a stored product re-fetches that product", async ({ page }) => {
    // Persisting the last product is only worth anything if boot re-fetches it;
    // the panel is meant to come back where the user left it, not on the grid.
    await openPreview(page, "marketplace", {
      state: { view: "product", repo: "utils/dcs-lua-common" },
    });
    await expectSent(page, { type: "openProduct", repo: "utils/dcs-lua-common" });
    await expect(page.getByTestId("product-title")).toHaveText("dcs-lua-common");

    // Back still lands on the list, which is unauthenticated on a fresh boot.
    await page.getByTestId("back-btn").click();
    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
  });

  test("a {product} with no product leaves the page busy rather than blank", async ({ page }) => {
    // Every other case guards on the payload before touching state. This one
    // used to clear productBusy and null out state.product before dereferencing
    // m.product.repo — so a malformed push would throw halfway through and
    // strand the page on a product card with nothing in it.
    const errors = await openPreview(page, "marketplace");
    await page.getByTestId("browse-anon-btn").click();
    await page
      .locator('[data-testid="mod-card"][data-repo="dcs-scripting/moose-lite"]')
      .getByTestId("card-title")
      .click();
    await expect(page.getByTestId("product-title")).toHaveText("MOOSE Lite");

    await hostSend(page, { type: "product" });
    // The last good product is still on screen; nothing was half-applied.
    await expect(page.getByTestId("product-title")).toHaveText("MOOSE Lite");
    expect(errors).toEqual([]);
  });

  test("the fallback avatar survives a non-Latin-1 mod name", async ({ page }) => {
    // Names come from GitHub, so they can be in any script. btoa() is a Latin-1
    // encoder and threw InvalidCharacterError on the first Cyrillic/CJK code
    // point — from inside an <img> error listener, i.e. exactly when the
    // fallback was needed.
    await openPreview(page, "marketplace");
    const src = await page.evaluate(() =>
      (window as unknown as { dcsUi: { initialsAvatar(n: string): string } }).dcsUi.initialsAvatar(
        "Восток Ми-8",
      ),
    );
    expect(src).toMatch(/^data:image\/svg\+xml;base64,/);
    // Decoded back through UTF-8 the initials are intact, not mojibake.
    const svg = await page.evaluate(
      (s) =>
        new TextDecoder().decode(
          Uint8Array.from(atob(s.split(",")[1]), (c: string) => c.charCodeAt(0)),
        ),
      src,
    );
    expect(svg).toContain(">ВМ<");
  });
});

// Open a product by repo id after browsing anon (shared setup for the #12 tests).
async function openProduct(page: import("@playwright/test").Page, repo: string): Promise<void> {
  await openPreview(page, "marketplace");
  await page.getByTestId("browse-anon-btn").click();
  await page
    .locator(`[data-testid="mod-card"][data-repo="${repo}"]`)
    .getByTestId("card-title")
    .click();
  await expect(page.getByTestId("product-title")).toBeVisible();
}

test.describe("marketplace — install manifest transparency (#12)", () => {
  const PRIVILEGED = "viper-drivers/f16-weapons-expansion";

  test("privileged mod shows all three risk badges before the install action", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("risk-summary")).toBeVisible();
    await expect(page.getByTestId("risk-badge")).toHaveCount(3);
    await expect(page.locator('[data-testid="risk-badge"][data-risk="links-files"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="risk-badge"][data-risk="runs-executable"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="risk-badge"][data-risk="pre-sanitize-script"]'),
    ).toBeVisible();
  });

  test("enumerates bundled content, symlinks, executables and mission scripts", async ({
    page,
  }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("section-bundles")).toBeVisible();
    await expect(page.getByTestId("section-symlinks")).toBeVisible();
    await expect(page.getByTestId("symlink-item")).toHaveCount(2);
    await expect(page.getByTestId("section-executables")).toBeVisible();
    await expect(page.getByTestId("executable-item")).toHaveCount(1);
    await expect(page.getByTestId("section-mission-scripts")).toBeVisible();
    await expect(page.getByTestId("mission-script-item")).toHaveCount(2);
  });

  test("a privileged mod never renders without its warnings (notice + badge)", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("sanitize-notice")).toBeVisible();
    await expect(page.getByTestId("before-sanitize-badge")).toContainText("1 before-sanitize");
    // The before-sanitize row is tagged; the after-sanitize one is not.
    await expect(
      page.locator('[data-testid="mission-script-item"][data-run="before-sanitize"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId("before-sanitize-tag")).toHaveCount(1);
  });

  test('the notice "Learn more" posts openDocs for the sandbox page', async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await page.getByTestId("sanitize-learn-more").click();
    await expectSent(page, { type: "openDocs", page: "sandbox" });
  });

  test("last-release recency is shown as a trust signal", async ({ page }) => {
    await openProduct(page, PRIVILEGED);
    await expect(page.getByTestId("release-recency")).toContainText("released");
  });

  test("a benign mod (links only) shows just the links-files risk and no notice", async ({
    page,
  }) => {
    await openProduct(page, "syria-collective/syria-4k-textures");
    await expect(page.getByTestId("risk-badge")).toHaveCount(1);
    await expect(page.locator('[data-testid="risk-badge"][data-risk="links-files"]')).toBeVisible();
    await expect(page.getByTestId("sanitize-notice")).toHaveCount(0);
    await expect(page.getByTestId("section-executables")).toHaveCount(0);
  });

  test("an after-sanitize-only mod lists the mission script without a notice", async ({ page }) => {
    await openProduct(page, "dcs-scripting/moose-lite");
    await expect(page.getByTestId("section-mission-scripts")).toBeVisible();
    await expect(page.getByTestId("mission-script-item")).toHaveCount(1);
    await expect(page.getByTestId("sanitize-notice")).toHaveCount(0);
    await expect(page.getByTestId("before-sanitize-badge")).toHaveCount(0);
  });

  test("an unreadable manifest renders the explicit unknown state, not missing sections", async ({
    page,
  }) => {
    await openProduct(page, "sound-mods/immersive-cockpit-audio");
    await expect(page.getByTestId("manifest-unknown")).toBeVisible();
    await expect(page.getByTestId("install-manifest")).toHaveCount(0);
    await expect(page.getByTestId("risk-summary")).toHaveCount(0);
    // Still installable — the action is present, but the actions are unknown.
    await expect(page.getByTestId("install-btn")).toBeVisible();
  });
});

test.describe("marketplace — a manifest reaching outside the DCS folders (#16)", () => {
  // The host derives this view from the release's dcs-studio.toml and refuses
  // the mod from the same list; the page's job is to say so instead of offering
  // an install that could only fail. Pushed directly so the shape under test is
  // exactly what src/core/domain/installManifestView.ts produces.
  const ESCAPING = {
    known: true,
    bundles: [{ path: "payload" }],
    symlinks: [
      {
        source: "payload/ok.lua",
        dest: "{SavedGames}/Scripts/ok.lua",
        resolved: "C:\\SG\\DCS\\Scripts\\ok.lua",
        escapes: false,
      },
      {
        source: "payload/evil.dll",
        dest: "{SavedGames}/../../Windows/System32/evil.dll",
        resolved: null,
        escapes: true,
      },
    ],
    entrypoints: [],
    missionScripts: [],
    counts: { bundles: 1, symlinks: 2, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 },
    risks: ["links-files"],
    unsafePaths: [
      {
        kind: "symlink-dest",
        value: "{SavedGames}/../../Windows/System32/evil.dll",
        reason:
          'Link destination "{SavedGames}/../../Windows/System32/evil.dll" reaches outside the configured DCS folders.',
      },
    ],
  };

  async function openEscapingProduct(page: import("@playwright/test").Page, installed = false) {
    await openProduct(page, "utils/dcs-lua-common");
    await hostSend(page, {
      type: "product",
      product: {
        repo: "shady/free-skins",
        name: "Free Skins Pack",
        author: "shady",
        repo_url: "https://github.com/shady/free-skins",
        avatar_url: "../media/icon.png",
        stars: 3,
        assets: [],
        release_tag: "v1.0.0",
        installable: true,
      },
      manifest: ESCAPING,
      installed,
    });
  }

  test("is not offered for install, and every reason is named", async ({ page }) => {
    await openEscapingProduct(page);
    await expect(page.getByTestId("unsafe-manifest-note")).toContainText("Not installable");
    await expect(page.getByTestId("unsafe-reasons")).toContainText(
      "reaches outside the configured DCS folders",
    );
    await expect(page.getByTestId("install-btn")).toHaveCount(0);
  });

  test("flags the offending rule while still showing the whole plan", async ({ page }) => {
    await openEscapingProduct(page);
    // The user can see exactly what the mod wanted to do, not just that it was
    // refused — and only the rule at fault is flagged.
    await expect(page.getByTestId("symlink-item")).toHaveCount(2);
    await expect(page.locator('[data-testid="symlink-item"][data-escapes="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="symlink-item"][data-escapes="true"]')).toContainText(
      "evil.dll",
    );
  });

  test("an already-installed mod still gets its uninstall action", async ({ page }) => {
    // Refusing the install must not strip the way out of one done earlier.
    await openEscapingProduct(page, true);
    await expect(page.getByTestId("uninstall-btn")).toBeVisible();
    await expect(page.getByTestId("unsafe-manifest-note")).toHaveCount(0);
  });
});
