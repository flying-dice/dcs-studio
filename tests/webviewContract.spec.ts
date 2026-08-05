import type { Page } from "@playwright/test";
import {
  CONSOLE_PROTOCOL,
  DOCS_PROTOCOL,
  LOG_PROTOCOL,
  MANIFEST_PROTOCOL,
  MARKETPLACE_PROTOCOL,
  MYMODS_PROTOCOL,
  NAV_PROTOCOL,
  NEWPROJECT_PROTOCOL,
  PUBLISH_PROTOCOL,
  SETUP_PROTOCOL,
  SKILLS_PROTOCOL,
  type WebviewProtocol,
} from "../src/core/app/webviewContract";
import { expect, test } from "./fixtures";
import { expectSent, hostSend, openPreview, sentMessages } from "./helpers";

// The WEBVIEW half of the declared message contract
// (`src/core/app/webviewContract.ts`), both directions, observed in Chromium.
//
//   webview -> host : the set of types the real media/*.js POSTED while being
//                     driven equals the declared `toHost` list.
//   host -> webview : every declared `toWebview` type was pushed at it and
//                     CONSUMED — the document differed either side of the
//                     dispatch (previews/harness.js measures that).
//
// Nothing here is read off the source. The audit's warning against a regex
// contract is the whole reason this spec drives the page instead: the console
// dispatches through a switch that delegates four cases to another module, the
// explorer posts from a second script, and marketplace posts from click
// handlers wired inside render functions — three shapes no scanner gets right.
// A drive gets all three for free, because it asks the browser.
//
// ## Falsifiability
//
// Both assertions are set EQUALITIES against the declared lists, so:
//   - drop a type from the contract and the observed set has one the contract
//     does not, which fails;
//   - empty the contract entirely and every observed type is undeclared, which
//     fails harder — this test cannot go green against a table that stopped
//     being checked;
//   - stop consuming a host push in media/*.js and its `changed` flag goes
//     false, which fails.
// The undeclared-message control at the end proves `changed` can be false, so
// the consumption assertions are not vacuous.
//
// ## Scope
//
// All ELEVEN webviews — every page in `previews/`, which is what
// test/integration/webview/webviewContract.test.ts asserts by holding the
// declared set plus the (now empty) `UNCOVERED_WEBVIEWS` to that directory. Nine
// are panels cards 08, 09 and 14 rolled presenters out to; the last two are the
// Agent Skills panel and the sidebar, which is a `WebviewView` and behaves
// differently enough in both directions to be worth reading as its own case.

interface Received {
  type: string;
  changed: boolean | null;
}

/** Arm the harness's consumption probe for the next navigation. */
async function armProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __contractProbe: boolean }).__contractProbe = true;
  });
}

async function receivedMessages(page: Page): Promise<Received[]> {
  return page.evaluate(
    () => (window as unknown as { __receivedMessages: Received[] }).__receivedMessages,
  );
}

/** What one driven session observed, folded into the running totals. */
async function collect(
  page: Page,
  sent: Set<string>,
  consumed: Map<string, boolean>,
): Promise<void> {
  for (const m of await sentMessages(page)) sent.add(m.type);
  for (const r of await receivedMessages(page)) {
    // A type counts as consumed if ANY delivery changed the document: a repeat
    // push of an identical status legitimately renders to the same markup.
    consumed.set(r.type, (consumed.get(r.type) ?? false) || r.changed === true);
  }
}

/** Both directions of one protocol, asserted against what the drive observed. */
function assertContract(
  protocol: WebviewProtocol,
  sent: Set<string>,
  consumed: Map<string, boolean>,
): void {
  expect([...sent].sort(), "messages the webview posted").toEqual([...protocol.toHost].sort());
  expect([...consumed.keys()].sort(), "messages pushed at the webview").toEqual(
    [...protocol.toWebview].sort(),
  );
  for (const type of protocol.toWebview) {
    const silent = protocol.silent.includes(type);
    // Silent messages are asserted to be silent, not skipped: one that starts
    // rendering something fails here until the declaration is corrected.
    expect(consumed.get(type), silent ? `${type} (declared silent)` : type).toBe(!silent);
  }
}

test.describe("console ↔ ConsolePresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: posts `ready`, and the fixture answers `status` + `explorerConfig`.
    const errors = await openPreview(page, "console");
    await expect(page.getByTestId("status-label")).toHaveText(/Connected/);

    // Console tab — the three reply shapes the fixture scripts off the code.
    const code = page.getByTestId("code-input");
    for (const [snippet, kind] of [
      ["return 1", "result"],
      ["error here", "error"],
      ["print here", "print"],
    ]) {
      await code.fill(snippet);
      await page.getByTestId("run-btn").click();
      await expect(page.locator(`[data-testid="log-entry"][data-kind="${kind}"]`)).toHaveCount(1);
    }

    // Explorer tab — opening it reads `_G` (inspect/inspectResult).
    await page.locator('.tab[data-tab="explorer"]').click();
    const node = (path: string) => `[data-testid="tree-node"][data-path="${path}"]`;
    await expect(page.locator(node("_G"))).toBeVisible();

    // Expanding a table (expand/expandResult).
    await page.locator(`${node("_G/db")} > .row`).click();
    await expect(page.locator(node("_G/db/Units"))).toBeVisible();

    // Clicking a function resolves its parameters (signature/signatureResult).
    await page.locator(`${node("_G/outText")} > .row`).click();
    await expect(page.locator(`${node("_G/outText")} [data-testid="node-preview"]`)).toHaveText(
      /text/,
    );

    // Exporting a table (export/exportDone).
    const exportBtn = page.locator(`${node("_G/net")} > .row > [data-testid="node-export"]`);
    await page.locator(`${node("_G/net")} > .row`).hover();
    await exportBtn.click();
    await expect(exportBtn).toBeEnabled();

    // Refresh releases the sim-side refs (clearExplorer).
    await page.getByTestId("refresh-btn").click();
    await expect(page.locator(node("_G"))).toBeVisible();

    // The offline CTA is the only source of `launch`, so the status line has to
    // be pushed offline first.
    await hostSend(page, {
      type: "status",
      status: {
        gui: { connected: false, dcsTime: null },
        mission: { connected: false, dcsTime: null },
      },
    });
    await page.getByTestId("launch-btn").click();
    await expect(page.getByTestId("launch-btn")).toHaveText("Launching…");

    await collect(page, sent, consumed);
    assertContract(CONSOLE_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("marketplace ↔ MarketplacePresenter message contract", () => {
  const F16 = "viper-drivers/f16-weapons-expansion";
  const BROKEN = "hoggit-liveries/usaf-aggressors";
  const card = (repo: string) => `[data-testid="mod-card"][data-repo="${repo}"]`;

  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    // Session 1 — the anonymous browse path, a product, and the install
    // lifecycle. `signIn` is unreachable from here (the wall is gone once you
    // browse), so it gets its own load below.
    await armProbe(page);
    const errors = await openPreview(page, "marketplace");
    await expect(page.getByTestId("signin-wall")).toBeVisible();

    await page.getByTestId("browse-anon-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    // Explicit refresh (discover).
    await page.getByTestId("refresh-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);

    // A product that loads (openProduct -> product:busy, product).
    await page.locator(card(F16)).getByTestId("card-title").click();
    await expect(page.getByTestId("product-title")).toHaveText("F-16C Weapons Expansion");

    // `product:busy` needs pushing at a LOADED page to be visible at all: the
    // webview puts itself into the loading shell the instant the card is
    // clicked, so the host's own busy push lands on markup identical to what is
    // already rendered. It is still a message the webview must consume — a
    // second load of the same repo (the retry button) is exactly this — so the
    // drive puts the page back into it deliberately, then backs out.
    await hostSend(page, { type: "product:busy", repo: F16 });
    await expect(page.getByTestId("product-title")).toHaveCount(0);
    await page.getByTestId("back-btn").click();
    await page.locator(card(F16)).getByTestId("card-title").click();
    await expect(page.getByTestId("product-title")).toHaveText("F-16C Weapons Expansion");

    // The two links off the product page.
    await page.getByTestId("view-github-btn").click();
    await page.getByTestId("sanitize-learn-more").click();

    // Install and remove it again.
    await page.getByTestId("install-btn").click();
    await expect(page.getByTestId("install-progress")).toBeVisible();
    await expect(page.getByTestId("installed-row")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("uninstall-btn").click();
    await expect(page.getByTestId("install-btn")).toBeVisible({ timeout: 5000 });

    // A failure the fixture never produces on its own.
    await hostSend(page, { type: "installError", repo: F16, message: "Download failed." });
    await expect(page.getByTestId("install-error")).toContainText("Download failed.");

    // Back to the grid, where a listings failure is the thing on screen.
    await page.getByTestId("back-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await hostSend(page, { type: "listings:error", message: "GitHub rate limit exceeded." });
    await expect(page.getByTestId("list-error")).toContainText("rate limit");

    // Reload the grid, then open the repo the fixture always fails
    // (openProduct -> product:busy, product:error).
    await page.getByTestId("refresh-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await page.locator(card(BROKEN)).getByTestId("card-title").click();
    await expect(page.getByTestId("product-error")).toContainText("502 Bad Gateway");

    await collect(page, sent, consumed);

    // Session 2 — the sign-in wall's other button.
    await armProbe(page);
    const errors2 = await openPreview(page, "marketplace");
    await page.getByTestId("signin-btn").click();
    await expect(page.getByTestId("mod-card")).toHaveCount(12);
    await collect(page, sent, consumed);

    assertContract(MARKETPLACE_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
    expect(errors2).toEqual([]);
  });
});

test.describe("mymods ↔ MyModsPresenter message contract", () => {
  const SRS = "Owner/DCS-SRS";
  const row = (page: Page, repo: string) =>
    page.locator(`[data-testid="mod-row"][data-repo="${repo}"]`);

  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: media/mymods.js posts `refresh` from the bottom of its IIFE and the
    // fixture answers `init`.
    const errors = await openPreview(page, "mymods");
    await expect(page.getByTestId("mod-row")).toHaveCount(5);

    // The four panel-level buttons.
    await page.getByTestId("shortcut-btn").click();
    await page.getByTestId("reveal-bat-btn").click();
    await page.getByTestId("clean-uninstall-btn").click();
    await page.getByTestId("refresh-btn").click();

    // An entrypoint's Launch/Stop pair — the fixture scripts the `entrypoint`
    // replies, so the row's running state is what proves consumption.
    const ep = page.locator(`[data-ep="${SRS}::srs-server"]`);
    await ep.getByTestId("launch-btn").click();
    await expect(ep.getByTestId("stop-btn")).toBeVisible();
    await ep.getByTestId("stop-btn").click();
    await expect(ep.getByTestId("launch-btn")).toBeVisible();

    // The script-execution notice's "Learn more" is the page's only `openDocs`.
    await page
      .locator(`[data-testid="mod-manifest"][data-repo="${SRS}"]`)
      .getByTestId("mod-sanitize-learn-more")
      .click();

    // Per-mod buttons, each on a DIFFERENT mod: Update and Uninstall latch their
    // row busy, and a latched row's buttons are disabled — driving them all
    // through one mod would be driving a page the user could not.
    await row(page, "Owner/Plain-Mod").getByTestId("open-dir-btn").click();
    await row(page, "Owner/Plain-Mod").getByTestId("github-btn").click();
    await row(page, "Owner/Risky-Mod").getByTestId("update-btn").click();
    await expect(row(page, "Owner/Risky-Mod").getByTestId("update-btn")).toBeDisabled();
    await row(page, "Owner/Inert-Mod").getByTestId("uninstall-btn").click();

    // The enable switch, both ways — the checkbox is visually replaced by the
    // slider, so it is driven through the label as a user does.
    await row(page, "Owner/Disabled-Mod").locator(".switch").click();
    await row(page, "Owner/Plain-Mod").locator(".switch").click();

    // `busy` and `progress` have no fixture reply behind them (the real host
    // sends them off a lifecycle action), so they are pushed directly.
    await hostSend(page, { type: "busy", repo: SRS, busy: true });
    await expect(row(page, SRS).getByTestId("update-btn")).toBeDisabled();
    await hostSend(page, { type: "progress", repo: SRS, label: "Downloading v2…" });
    await expect(row(page, SRS).getByTestId("mod-progress")).toHaveText("Downloading v2…");

    await collect(page, sent, consumed);
    assertContract(MYMODS_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("log ↔ LogPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: media/log.js posts `ready` from the bottom of its IIFE and the
    // fixture answers `init` with five entries, one per level.
    const errors = await openPreview(page, "log");
    await expect(page.getByTestId("log-row")).toHaveCount(5);

    // `append` — the tail's steady state. The webview batches this into the next
    // animation frame, which is why the harness re-checks the document a frame
    // after the dispatch rather than only inline.
    await hostSend(page, {
      type: "append",
      entries: [
        {
          seq: 6,
          time: "2026-07-13 12:00:05.006",
          level: "INFO",
          subsystem: "my-mod",
          thread: "Main",
          message: "another line arrived",
          mine: true,
          cont: [],
        },
      ],
      cont: [],
      dropped: 2,
    });
    await expect(page.getByTestId("log-row")).toHaveCount(6);
    await expect(page.getByTestId("dropped-badge")).toHaveText("2 dropped");

    // `reset` — DCS truncated the log on restart.
    await hostSend(page, { type: "reset" });
    await expect(page.getByTestId("restart-divider")).toBeVisible();
    await expect(page.getByTestId("log-row")).toHaveCount(0);

    // `mod` — the identity re-derived after the workspace changed. Pushing null
    // is what hides the filter, so it is the visible half of the pair.
    await expect(page.getByTestId("mine-toggle")).toBeVisible();
    await hostSend(page, { type: "mod", mod: null });
    await expect(page.getByTestId("mine-toggle")).toBeHidden();

    // `clear` — the toolbar button, which empties the host's backlog too.
    await page.getByTestId("clear-btn").click();
    await expect(page.getByTestId("dropped-badge")).toBeHidden();

    // `fileState` — the missing pane, and the only route to `openSettings`:
    // the button lives inside that pane, so the file has to go away first.
    await hostSend(page, {
      type: "fileState",
      state: "missing",
      file: "C:\\Users\\test\\Saved Games\\DCS\\Logs\\dcs.log",
    });
    await expect(page.getByTestId("missing-pane")).toBeVisible();
    await page.getByTestId("open-settings-btn").click();

    await collect(page, sent, consumed);
    assertContract(LOG_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("publish ↔ PublishPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    // Session 1 — a workspace with a folder. media/publish.js posts `refresh`
    // from the bottom of its IIFE and the fixture answers `init`.
    await armProbe(page);
    const errors = await openPreview(page, "publish");
    await expect(page.getByTestId("check-row")).toHaveCount(3);

    // Share: the fixture scripts the real bracket the host sends — busy on, a
    // progress `log` line, `shareDone`, busy off.
    await page.getByTestId("share-btn").click();
    await expect(page.getByTestId("share-result")).toBeVisible();

    // `openExternal` — the repo link the share result just rendered. (The
    // already-shared note carries the same message, but this scenario's project
    // is not on GitHub yet, which is the state that reaches Share at all.)
    await page.getByTestId("share-repo-link").click();

    // Release: the tag box is prefilled from the manifest version and the repo
    // box was auto-filled by `shareDone`, so the webview's own owner/name+tag
    // validation passes and the message is posted.
    await page.getByTestId("release-btn").click();
    await expect(page.getByTestId("release-result")).toBeVisible();

    // Re-check is the second, explicit source of `refresh`.
    await page.getByTestId("recheck-btn").click();
    await collect(page, sent, consumed);

    // Session 2 — `nofolder` is the one host push that cannot be reached from a
    // page that has a folder: it replaces the whole panel, so it is the fixture's
    // answer to the boot handshake in its own load.
    await armProbe(page);
    const errors2 = await openPreview(page, "publish", { query: { scenario: "nofolder" } });
    await expect(page.getByTestId("no-folder-note")).toBeVisible();
    await collect(page, sent, consumed);

    assertContract(PUBLISH_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
    expect(errors2).toEqual([]);
  });
});

test.describe("setup ↔ SetupPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: unlike every other covered panel, media/setup.js posts NO handshake
    // — it renders an empty form at load and waits. `init` is pushed unprompted,
    // which the fixture does on DOMContentLoaded as SetupPanel does from its
    // constructor.
    const errors = await openPreview(page, "setup");
    await expect(page.getByTestId("cand-row")).toHaveCount(4);

    // `browse` -> `browsed`, driven through the userdata picker. The fixture
    // answers with a path, and the input taking it is what proves consumption.
    await page.locator('[data-browse="saved"]').click();
    await expect(page.getByTestId("saved-input")).toHaveValue("E:\\Saved Games\\DCS");

    // `save` -> `saved`, which flashes the note beside the button.
    await page.getByTestId("save-btn").click();
    await expect(page.getByTestId("saved-note")).toBeVisible();

    // `redetect` — the toolbar's second, explicit source of `init`.
    await page.getByTestId("redetect-btn").click();
    await expect(page.getByTestId("cand-row")).toHaveCount(4);

    await collect(page, sent, consumed);
    assertContract(SETUP_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("newproject ↔ NewProjectPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: media/newproject.js renders only when the host pushes `init`, which
    // the fixture does on DOMContentLoaded as the panel's constructor does
    // unprompted — and it posts `ready` at the bottom of its IIFE, which the
    // fixture answers with the same `init`, because the unprompted push can be
    // lost to the load race and this page has nothing else to render from
    // (card 24). So the handshake is driven by simply loading the page.
    const errors = await openPreview(page, "newproject");
    await expect(page.getByTestId("template-tile")).toHaveCount(5);

    // A tile click is local to the document; the location button and Browse are
    // the two wirings of `browse`, and the fixture answers `browsed`.
    await page.getByTestId("template-tile").first().click();
    await page.getByTestId("browse-btn").click();
    await expect(page.getByTestId("location-path")).toHaveText("D:\\DCS Projects");

    // `error` — and it is the ONLY reply a `create` has, because success ends
    // with the panel closed or the window reloaded and nothing left to tell
    // (card 25, which removed this protocol's one silent message). The name
    // "taken" is what the fixture fails, the way a real EEXIST does.
    await page.getByTestId("name-input").fill("taken");
    await page.getByTestId("create-btn").click();
    await expect(page.getByTestId("error-note")).toContainText("already exists");

    await collect(page, sent, consumed);
    assertContract(NEWPROJECT_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("manifest ↔ ManifestPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: the form's opening state crosses inside the DOCUMENT, as the inline
    // `window.__BOOTSTRAP__` the host renders and the fixture stands in for — the
    // one covered panel with no handshake to lose (cf. cards 22-24).
    //
    // It does post one thing at load, and only one: `bundlePreview`. The document
    // carries the manifest but not the DISK, and existence and size are the
    // host's to know, so the archive block is the single thing the bootstrap
    // cannot bring with it. `bundlePreviewResult` arriving is what draws it.
    const errors = await openPreview(page, "manifest");
    await expect(page.getByTestId("bundle-row")).toHaveCount(1);
    await expect(page.getByTestId("bundle-archive")).toBeVisible();

    // `openDocs` — the `[[bundle]]` label's deep link into the manual (#71).
    await page.getByTestId("bundle-docs-link").click();
    await expectSent(page, { type: "openDocs", page: "mod-bundles" });

    // `edit`, and debounced: the form re-emits the WHOLE file 200ms after the
    // last keystroke, which is why this waits for the post rather than reading
    // the log straight after typing. `bundlePreview` rides the same debounce, so
    // this keystroke is also the second, non-boot source of it.
    await page.locator('[data-sec="project"][data-key="name"]').fill("renamed-in-the-form");
    await expect(page.getByTestId("toml-preview")).toContainText("renamed-in-the-form");
    await expectSent(page, { type: "edit" });

    // `roots` — the DCS paths changed under the open form. The resolved-dest line
    // is what consumes it: the fixture's symlink is anchored at {SavedGames}, so
    // re-rooting it re-renders where that link would land.
    await hostSend(page, {
      type: "roots",
      roots: { savedGames: "E:\\Re-rooted\\DCS", gameInstall: "" },
    });
    await expect(page.getByTestId("resolved-dest")).toContainText("E:\\Re-rooted\\DCS");

    // `external` — the document changed outside the form (a raw-text edit, an
    // undo, a revert, a git checkout), which re-seeds the whole model.
    await hostSend(page, {
      type: "external",
      rawText: '[project]\nname = "changed-in-the-editor"\n\n[[bundle]]\npath = "Scripts"\n',
    });
    await expect(page.locator('[data-sec="project"][data-key="name"]')).toHaveValue(
      "changed-in-the-editor",
    );

    await collect(page, sent, consumed);
    assertContract(MANIFEST_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("docs ↔ DocsPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    // Session 1 — the REAL shipped manual (media/docs-content.js, which the
    // preview loads unmodified). media/docs.js posts nothing at load and needs
    // nothing pushed at it: its opening page crosses inside the DOCUMENT as the
    // inline `window.__INITIAL_PAGE__` the host renders, so like the manifest form
    // there is no handshake here to lose (cf. cards 22-24).
    await armProbe(page);
    const errors = await openPreview(page, "docs");
    await expect(page.getByTestId("page-title")).toHaveText("Welcome to DCS Studio");

    // `run` — a page body's "try it" button. These live in the CONTENT script
    // rather than in markup docs.js owns, which is exactly the dispatch shape a
    // regex contract gets wrong and a drive gets for free.
    await page.getByTestId("command-btn").first().click();

    // `goto` — the host navigating a panel that is already open, which is the
    // only message it sends. The page pane and the TOC's active row both change.
    await hostSend(page, { type: "goto", page: "publishing" });
    await expect(page.getByTestId("page-title")).toHaveText("Publishing Your Mod");

    await collect(page, sent, consumed);

    // Session 2 — `openExternal`. The shipped manual has no https anchor in any
    // page body (card 14's journal records that as a finding), so the only way to
    // reach the real delegated handler's external-link branch is content that has
    // one: `?docs=links` swaps in a doc set whose page body carries a real link.
    // Driving a rendered anchor rather than one injected into the document keeps
    // this a measurement of media/docs.js and not of the test.
    await armProbe(page);
    const errors2 = await openPreview(page, "docs", { query: { docs: "links" } });
    await expect(page.getByTestId("page-title")).toHaveText("Links Page");
    await page.getByTestId("ext-link").click();
    await collect(page, sent, consumed);

    assertContract(DOCS_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
    expect(errors2).toEqual([]);
  });
});

test.describe("skills ↔ SkillsPresenter message contract", () => {
  const card = (page: Page, id: string) =>
    page.locator(`[data-testid="skill-card"][data-id="${id}"]`);

  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: media/skills.js posts `refresh` from the bottom of its IIFE and the
    // fixture answers `skills` with one card per status, which is what makes all
    // four action buttons reachable in a single load.
    const errors = await openPreview(page, "skills");
    await expect(page.getByTestId("skill-card")).toHaveCount(4);

    // The four `data-act` buttons, one per card, and deliberately spread across
    // DIFFERENT cards: which buttons a card draws depends on its status, so
    // Install lives on the not-installed one and Open/Remove only on cards that
    // reported an installed version. None of these four types appears as a
    // literal in media/skills.js at all — the click handler posts
    // `{ type: el.dataset.act }`, so the drive is the only thing that can
    // enumerate them.
    await card(page, "dcs-studio").getByTestId("install-btn").click();
    await card(page, "dcs-studio-2").getByTestId("open-installed-btn").click();
    await card(page, "dcs-studio-3").getByTestId("remove-btn").click();
    await card(page, "dcs-studio-4").getByTestId("view-bundled-btn").click();
    await expectSent(page, { type: "viewBundled", id: "dcs-studio-4" });

    // `skills` again, as a state no button can reach: with no folder open the
    // cards lose Install entirely and the note takes its place. The same message
    // type, and the reason it is the panel's only one — it is the whole screen.
    await hostSend(page, {
      type: "skills",
      installDir: ".claude/skills",
      hasWorkspace: false,
      skills: [],
    });
    await expect(page.getByTestId("no-workspace-note")).toBeVisible();
    await expect(page.getByTestId("empty-note")).toBeVisible();

    await collect(page, sent, consumed);
    assertContract(SKILLS_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("nav ↔ NavPresenter message contract", () => {
  test("the webview posts and consumes exactly the declared message set", async ({ page }) => {
    const sent = new Set<string>();
    const consumed = new Map<string, boolean>();

    await armProbe(page);
    // Boot: media/nav.js renders its rows and its "Bridge offline" footer from
    // static data in the script itself, so unlike every panel the sidebar is
    // COMPLETE at load — and it still posts `ready`, which the fixture answers
    // with all three pushes, because the host's unprompted opening pushes can be
    // lost to the load race and nothing else re-pushes them (card 29). The pushes
    // driven below are the host volunteering the same three facts later.
    const errors = await openPreview(page, "nav");
    await expect(page.getByTestId("nav-item")).toHaveCount(10);
    await expect(page.getByTestId("status-label")).toHaveText("Bridge offline");

    // `status` — the footer, from the coarse shape the presenter collapses the two
    // bridges into. A running mission is the state that changes the most of it.
    await hostSend(page, { type: "status", status: { connected: true, dcsTime: 213 } });
    await expect(page.getByTestId("status-label")).toHaveText("Mission running");
    await expect(page.getByTestId("status-time")).toHaveText("t 213s");

    // `skills` — the badge on the Agent Skills row, which is drawn only above zero.
    await hostSend(page, { type: "skills", updates: 2 });
    const skillsRow = page.locator('[data-testid="nav-item"][data-id="skills"]');
    await expect(skillsRow.getByTestId("nav-badge")).toHaveText("2");

    // `manifest` — one boolean behind two rows: "Create a Mod" becomes "Edit
    // Project", and Publish Mod stops being hidden.
    const publishRow = page.locator('[data-testid="nav-item"][data-id="publish"]');
    await expect(publishRow).toBeHidden();
    await hostSend(page, { type: "manifest", hasManifest: true });
    await expect(publishRow).toBeVisible();
    await expect(page.locator('[data-testid="nav-item"][data-id="create"] .label')).toHaveText(
      "Edit Project",
    );

    // `run` — the sidebar's whole host-bound half, from one delegated handler over
    // every row. The command id comes off the clicked row's own `data-command`.
    //
    // Driven through a row that is on screen from the FIRST paint, deliberately
    // not through Publish Mod: a `run` that could only be reached after the
    // `manifest` push had been consumed would make the two halves of this drive
    // depend on each other, and a mutation that broke the manifest handler would
    // then fail on a missing click rather than on the message it actually broke.
    await skillsRow.click();
    await expectSent(page, { type: "run", command: "dcs.skills.open" });

    await collect(page, sent, consumed);
    assertContract(NAV_PROTOCOL, sent, consumed);
    expect(errors).toEqual([]);
  });
});

test.describe("the consumption probe itself", () => {
  test("a message no webview declares changes nothing", async ({ page }) => {
    // The negative control. Every `changed: true` above is only evidence
    // because `changed` can come back false — otherwise "the document differed"
    // would be true for any input and the contract assertions would be vacuous.
    await armProbe(page);
    await openPreview(page, "console");
    await expect(page.getByTestId("status-label")).toHaveText(/Connected/);

    await hostSend(page, { type: "notInTheContract", value: 1 });
    const received = await receivedMessages(page);
    expect(received.at(-1)).toEqual({ type: "notInTheContract", changed: false });
    // …and at least one real push in the same page DID change it.
    expect(received.some((r) => r.changed === true)).toBe(true);
  });
});
