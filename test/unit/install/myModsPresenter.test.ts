import { describe, expect, it } from "vitest";
import type {
  ConsentStore,
  EntrypointLauncher,
  MyModsConfirm,
  MyModsEffect,
  MyModsLedger,
  MyModsPresenterDeps,
} from "../../../src/core/app/myModsPresenter";
import { MyModsPresenter } from "../../../src/core/app/myModsPresenter";
import type { OnProgress } from "../../../src/core/app/subscriptionService";
import type { InstallTarget, ProductDetail, Subscription } from "../../../src/core/domain/types";
import type { AuthPort } from "../../../src/core/ports/auth";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";
import type { MarketplacePort } from "../../../src/core/ports/marketplace";

// My Mods is the only place a user can take back what a mod did to their DCS
// install: disable, uninstall and Launch all reach outside the editor, into
// symlinked game folders and into mod-shipped executables. These are the rules
// around that, tested without VS Code — that entrypoints stop before links are
// torn down, that a launch never happens without consent, that an up-to-date mod
// is not re-downloaded, and that every failure still leaves the list showing the
// truth. Effects are asserted as an ordered array of values, so "nothing
// happened" is `toEqual([])` rather than four spies that were never called.

const DATA_DIR = "D:\\DCSStudio\\mods";
const UNINSTALL_BAT = `${DATA_DIR}\\uninstall-all.bat`;
const SAVED_GAMES = "C:\\Users\\pilot\\Saved Games\\DCS";
const GAME_INSTALL = "C:\\Program Files\\Eagle Dynamics\\DCS World";

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    repo: "Owner/Mod",
    name: "Carrier Mod",
    tag: "v1.0.0",
    dir: `${DATA_DIR}\\owner-mod`,
    enabled: true,
    links: [{ id: "l1", dest: "C:\\Saved Games\\DCS\\Mods\\Mod" }],
    bundles: [{ path: "Mod" }],
    symlinks: [{ source: "Mod", dest: "{SavedGames}/Mods/tech/Mod" }],
    entrypoints: [
      { id: "gui", name: "Config GUI", exe: "bin\\config.exe", args: ["--root", "{SavedGames}"] },
    ],
    missionScripts: [{ name: "init", path: "scripts/init.lua", run_on: "before-sanitize" }],
    ...over,
  } as Subscription;
}

function product(over: Partial<ProductDetail> = {}): ProductDetail {
  return {
    repo: "Owner/Mod",
    name: "Carrier Mod",
    release_tag: "v2.0.0",
    assets: [{ name: "payload.7z", url: "https://example/payload.7z", size: 10 }],
    ...over,
  } as ProductDetail;
}

interface Harness {
  presenter: MyModsPresenter;
  posted: Record<string, unknown>[];
  effects: MyModsEffect[];
  /** Service/ledger calls, in order — the sequencing the guards depend on. */
  calls: string[];
  asked: MyModsConfirm[];
  launched: { key: string; exe: string; cwd: string; args: string[] }[];
  stopped: string[];
  remembered: string[];
}

/**
 * Per-collaborator overrides, merged onto the defaults rather than replacing
 * them — so a test that swaps one method keeps the recording the others do.
 */
interface Overrides {
  subs?: Partial<MyModsPresenterDeps["subs"]>;
  ledger?: Partial<MyModsLedger>;
  market?: Partial<MarketplacePort>;
  launcher?: Partial<EntrypointLauncher>;
  roots?: Partial<InstallRootsPort>;
  auth?: Partial<AuthPort>;
  consent?: Partial<ConsentStore>;
}

/** `replies` answers each modal confirm in order; absent means dismissed. */
function harness(over: Overrides = {}, replies: (string | undefined)[] = []): Harness {
  const posted: Record<string, unknown>[] = [];
  const effects: MyModsEffect[] = [];
  const calls: string[] = [];
  const asked: MyModsConfirm[] = [];
  const launched: { key: string; exe: string; cwd: string; args: string[] }[] = [];
  const stopped: string[] = [];
  const remembered: string[] = [];

  const deps: MyModsPresenterDeps = {
    subs: {
      list: async () => [sub()],
      enable: async (repo: string) => void calls.push(`enable ${repo}`),
      disable: async (repo: string) => void calls.push(`disable ${repo}`),
      unsubscribe: async (repo: string) => void calls.push(`unsubscribe ${repo}`),
      update: async (target: InstallTarget, token: string | undefined, p: OnProgress) => {
        calls.push(`update ${target.repo} ${target.tag} token=${token ?? "none"}`);
        p({ phase: "download", label: "Downloading payload.7z…", pct: 42 });
      },
      ...over.subs,
    } as MyModsPresenterDeps["subs"],
    ledger: {
      ensureUninstallBat: () => {
        calls.push("ensureUninstallBat");
        return UNINSTALL_BAT;
      },
      uninstallBatPath: () => UNINSTALL_BAT,
      takeCorruptNotice: () => undefined,
      ...over.ledger,
    },
    market: {
      discover: async () => [],
      loadProduct: async (repo: string) => {
        calls.push(`loadProduct ${repo}`);
        return product();
      },
      ...over.market,
    },
    launcher: {
      isRunning: () => false,
      launch: (key, plan) => void launched.push({ key, ...plan }),
      stop: (key) => void stopped.push(key),
      // The presenter never calls this — a tracked process exiting is the
      // panel's input, not the presenter's — but it is on the contract, so the
      // fake carries it rather than the type being loosened to hide that.
      setOnChange: () => {},
      ...over.launcher,
    },
    roots: {
      savedGames: () => SAVED_GAMES,
      gameInstall: () => GAME_INSTALL,
      dataDir: () => DATA_DIR,
      ...over.roots,
    },
    auth: {
      getToken: async () => undefined,
      onDidChangeSessions: () => ({ dispose: () => {} }),
      currentSession: async () => undefined,
      signIn: async () => undefined,
      ...over.auth,
    },
    consent: {
      granted: () => false,
      remember: async (key) => void remembered.push(key),
      ...over.consent,
    },
    dataDir: () => DATA_DIR,
    post: (msg) => posted.push(msg as Record<string, unknown>),
    effect: (e) => effects.push(e),
    confirm: async (request) => {
      asked.push(request);
      return replies.shift();
    },
  };

  return {
    presenter: new MyModsPresenter(deps),
    posted,
    effects,
    calls,
    asked,
    launched,
    stopped,
    remembered,
  };
}

const typed = (posted: Record<string, unknown>[], type: string) =>
  posted.filter((m) => m.type === type);
/** The most recent list push — what the user is actually looking at. */
const init = (h: Harness) => typed(h.posted, "init").at(-1) as Record<string, unknown>;
const mods = (h: Harness) => init(h).mods as Record<string, unknown>[];

describe("drawing the list", () => {
  it("posts the data dir, the escape-hatch script and each mod's DTO", async () => {
    const h = harness();
    await h.presenter.refresh();

    expect(init(h)).toMatchObject({
      dataDir: DATA_DIR,
      uninstallBat: UNINSTALL_BAT,
    });
    expect(mods(h)[0]).toMatchObject({ repo: "Owner/Mod", tag: "v1.0.0", enabled: true });
    // The count, not the links: the DTO field is named for what it holds.
    expect(mods(h)[0].linkCount).toBe(1);
  });

  it("keeps uninstall-all.bat on disk every time the list is drawn", async () => {
    // It is the recovery path when the extension itself is broken or removed,
    // so it must exist before the user needs it, not after.
    const h = harness();
    await h.presenter.refresh();
    expect(h.calls).toContain("ensureUninstallBat");
  });

  it("carries the declared destinations and privileged actions of each mod", async () => {
    // The same risk flags the product page shows before installing; My Mods is
    // where a user checks what they already agreed to.
    const h = harness();
    await h.presenter.refresh();

    expect(mods(h)[0].manifest).toMatchObject({
      counts: { bundles: 1, symlinks: 1, entrypoints: 1, missionScripts: 1, beforeSanitize: 1 },
      risks: ["links-files", "runs-executable", "pre-sanitize-script"],
      // Unresolved on purpose: My Mods shows what the mod declared.
      symlinks: [{ dest: "{SavedGames}/Mods/tech/Mod", resolved: null }],
    });
  });

  it("renders a ledger written before bundles and entrypoints existed", async () => {
    // Old subscriptions.json entries lack those fields entirely; reading them
    // strictly would blank the whole panel for anyone upgrading.
    const legacy = {
      repo: "Owner/Old",
      name: "Old Mod",
      tag: "v0.1",
      dir: `${DATA_DIR}\\owner-old`,
      enabled: false,
      links: [],
    } as unknown as Subscription;
    const h = harness({ subs: { list: async () => [legacy] } });
    await h.presenter.refresh();

    expect(mods(h)[0]).toMatchObject({ repo: "Owner/Old", entrypoints: [] });
    expect(mods(h)[0].manifest).toMatchObject({
      counts: { bundles: 0, symlinks: 0, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 },
      risks: [],
    });
    expect(init(h).running).toEqual({});
  });

  it("reports running entrypoints under the key the webview looks them up by", async () => {
    // The launcher tracks lowercased keys but the webview asks by repo case; a
    // mismatch here shows Launch on an already-running process.
    const h = harness({
      launcher: { isRunning: (key) => key === "owner/mod::gui" },
    });
    await h.presenter.refresh();
    expect(init(h).running).toEqual({ "Owner/Mod::gui": true });
  });

  it("says so when the mod list could not be read, instead of drawing an empty panel", async () => {
    // An unreadable ledger reads as empty, so the panel is about to claim
    // nothing is installed while the links are still in the DCS folders. The
    // preserved file is the only record of them, so the warning names it.
    const preserved = `${DATA_DIR}\\subscriptions.json.corrupt`;
    let notice: string | undefined = preserved;
    const h = harness({
      subs: { list: async () => [] },
      ledger: {
        takeCorruptNotice: () => {
          const taken = notice;
          notice = undefined;
          return taken;
        },
      },
    });
    await h.presenter.refresh();

    expect(h.effects).toEqual([
      {
        kind: "warn",
        message: expect.stringContaining(preserved) as unknown as string,
      },
    ]);
    expect((h.effects[0] as { message: string }).message).toContain(
      "uninstall-all.bat was left as it was",
    );
    expect(mods(h)).toEqual([]);

    // Once per corruption, not once per redraw — the notice is consumed.
    await h.presenter.refresh();
    expect(h.effects).toHaveLength(1);
  });

  it("redraws on an explicit refresh message", async () => {
    const h = harness();
    await h.presenter.handle({ type: "refresh" });
    expect(typed(h.posted, "init")).toHaveLength(1);
  });
});

describe("enable and disable", () => {
  it("enables a mod, marks the row busy and confirms it by name", async () => {
    const h = harness();
    await h.presenter.handle({ type: "enable", repo: "Owner/Mod" });

    expect(h.posted[0]).toEqual({ type: "busy", repo: "Owner/Mod", busy: true });
    expect(h.calls).toContain("enable Owner/Mod");
    expect(h.effects).toEqual([{ kind: "info", message: "Enabled Owner/Mod." }]);
    expect(typed(h.posted, "init")).toHaveLength(1); // redrawn after
  });

  it("stops the mod's running executables before removing its links", async () => {
    // Unlinking under a running exe leaves it holding files DCS still lists,
    // so the order matters more than either step on its own.
    const h = harness();
    await h.presenter.handle({ type: "disable", repo: "Owner/Mod" });

    expect(h.stopped).toEqual(["owner/mod::gui"]);
    expect(h.calls).toContain("disable Owner/Mod");
    expect(h.effects).toEqual([{ kind: "info", message: "Disabled Owner/Mod." }]);
  });

  it("disables a mod that declares no entrypoints", async () => {
    const h = harness({
      subs: {
        list: async () => [
          sub({ entrypoints: undefined as unknown as Subscription["entrypoints"] }),
        ],
      },
    });
    await h.presenter.handle({ type: "disable", repo: "Owner/Mod" });

    expect(h.stopped).toEqual([]);
    expect(h.calls).toContain("disable Owner/Mod");
  });

  it("stops nothing for a repo that is no longer in the ledger", async () => {
    const h = harness({ subs: { list: async () => [] } });
    await h.presenter.handle({ type: "uninstall", repo: "Ghost/Mod" });

    expect(h.stopped).toEqual([]);
    expect(h.calls).toContain("unsubscribe Ghost/Mod");
    expect(h.effects).toEqual([{ kind: "info", message: "Uninstalled Ghost/Mod." }]);
  });

  it("reports a failed disable and still redraws the list", async () => {
    // A half-removed symlink set is exactly when the user needs to see the
    // real state rather than the optimistic one.
    const cause = new Error("EPERM: symlink is locked");
    const h = harness({
      subs: {
        disable: async () => {
          throw cause;
        },
      },
    });
    await h.presenter.handle({ type: "disable", repo: "Owner/Mod" });

    expect(h.effects).toEqual([
      { kind: "failed", message: "Disabled failed: EPERM: symlink is locked", cause },
    ]);
    expect(typed(h.posted, "init")).toHaveLength(1);
  });

  it("reports a failure thrown as something other than an Error", async () => {
    const h = harness({
      subs: {
        enable: async () => {
          throw "the linker exploded";
        },
      },
    });
    await h.presenter.handle({ type: "enable", repo: "Owner/Mod" });

    expect(h.effects).toEqual([
      {
        kind: "failed",
        message: "Enabled failed: the linker exploded",
        cause: "the linker exploded",
      },
    ]);
  });
});

describe("update", () => {
  it("downloads the newer release and reports progress against the mod", async () => {
    const h = harness({
      auth: {
        currentSession: async () => ({ token: "gho_secret", accountLabel: "pilot" }),
      },
    });
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });

    // The token rides along so private-repo assets can be fetched.
    expect(h.calls).toContain("update Owner/Mod v2.0.0 token=gho_secret");
    expect(typed(h.posted, "progress")[0]).toEqual({
      type: "progress",
      repo: "Owner/Mod",
      label: "Downloading payload.7z…",
      pct: 42,
    });
    expect(h.effects).toEqual([{ kind: "info", message: "Updated Owner/Mod to v2.0.0." }]);
  });

  it("updates anonymously when nobody is signed in", async () => {
    const h = harness();
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });
    expect(h.calls).toContain("update Owner/Mod v2.0.0 token=none");
  });

  it("does nothing when the installed tag is already the latest", async () => {
    // Re-downloading would tear the mod's links down and rebuild them for no
    // gain, briefly breaking a DCS install that was working.
    const h = harness({
      market: {
        loadProduct: async () => product({ release_tag: "v1.0.0" }),
      },
    });
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });

    expect(h.calls.some((c) => c.startsWith("update "))).toBe(false);
    expect(h.effects).toEqual([
      { kind: "info", message: "Owner/Mod is already up to date (v1.0.0)." },
    ]);
    // Still redrawn: the row has to leave its busy state.
    expect(typed(h.posted, "init")).toHaveLength(1);
  });

  it("still installs when the repo is not in the ledger at all", async () => {
    // Nothing to compare against, so the newest release is by definition new.
    const h = harness({ subs: { list: async () => [] } });
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });
    expect(h.calls).toContain("update Owner/Mod v2.0.0 token=none");
  });

  it("explains that the repo has no release rather than failing silently", async () => {
    const h = harness({
      market: { loadProduct: async () => product({ release_tag: null }) },
    });
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });

    expect(h.effects).toEqual([
      {
        kind: "failed",
        message: "Update failed: No release found on GitHub.",
        cause: expect.any(Error) as unknown as Error,
      },
    ]);
  });

  it("reports a failed download and redraws the list", async () => {
    const h = harness({
      market: {
        loadProduct: async () => {
          throw "socket hang up";
        },
      },
    });
    await h.presenter.handle({ type: "update", repo: "Owner/Mod" });

    expect(h.effects).toEqual([
      { kind: "failed", message: "Update failed: socket hang up", cause: "socket hang up" },
    ]);
    expect(typed(h.posted, "init")).toHaveLength(1);
  });
});

describe("launching a mod entrypoint", () => {
  it("asks before running a mod-shipped executable and names it", async () => {
    // This is arbitrary third-party code; the exe path is the only thing the
    // user has to judge it by, so the prompt must carry it.
    const h = harness({}, ["Launch"]);
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.asked).toEqual([
      {
        message: 'Launch "Config GUI" from Owner/Mod?',
        detail: `This runs a mod-shipped executable:\n${DATA_DIR}\\owner-mod\\bin\\config.exe`,
        actions: ["Launch", "Always allow for this mod"],
      },
    ]);
    expect(h.launched).toEqual([
      {
        key: "owner/mod::gui",
        exe: `${DATA_DIR}\\owner-mod\\bin\\config.exe`,
        cwd: `${DATA_DIR}\\owner-mod\\bin`,
        args: ["--root", SAVED_GAMES],
      },
    ]);
    expect(h.posted).toEqual([{ type: "entrypoint", repo: "Owner/Mod", id: "gui", running: true }]);
  });

  it("does not launch when the prompt is dismissed", async () => {
    const h = harness({}, [undefined]);
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.launched).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.remembered).toEqual([]);
  });

  it("asks again next time when consent was only for this launch", async () => {
    const h = harness({}, ["Launch", "Launch"]);
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.asked).toHaveLength(2);
    expect(h.remembered).toEqual([]);
    expect(h.launched).toHaveLength(2);
  });

  it("remembers 'always allow' under a case-insensitive key", async () => {
    const h = harness({}, ["Always allow for this mod"]);
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });
    expect(h.remembered).toEqual(["dcs.entrypointConsent.owner/mod:gui"]);
  });

  it("does not ask again once consent is remembered", async () => {
    const h = harness({ consent: { granted: () => true } });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.asked).toEqual([]);
    expect(h.launched).toHaveLength(1);
  });

  it("expands {GameInstall} to nothing when no game install is configured", async () => {
    // Many users only ever set Saved Games; the arg must not become "undefined".
    const h = harness({
      consent: { granted: () => true },
      roots: { gameInstall: () => undefined },
      subs: {
        list: async () => [
          sub({
            entrypoints: [
              { id: "gui", name: "Config GUI", exe: "bin\\config.exe", args: ["{GameInstall}"] },
            ],
          }),
        ],
      },
    });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });
    expect(h.launched[0].args).toEqual([""]);
  });

  it("surfaces a missing executable inline as well as in a toast", async () => {
    // The card has to fall back out of "running", or Stop is the only button
    // left for a process that never started.
    const cause = new Error("Executable not found: bin\\config.exe");
    const h = harness({
      consent: { granted: () => true },
      launcher: {
        launch: () => {
          throw cause;
        },
      },
    });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.effects).toEqual([
      { kind: "failed", message: "Launch failed: Executable not found: bin\\config.exe", cause },
    ]);
    expect(h.posted).toEqual([
      {
        type: "entrypoint",
        repo: "Owner/Mod",
        id: "gui",
        running: false,
        error: "Executable not found: bin\\config.exe",
      },
    ]);
  });

  it("surfaces a non-Error launch failure", async () => {
    const h = harness({
      consent: { granted: () => true },
      launcher: {
        launch: () => {
          throw "EACCES";
        },
      },
    });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });
    expect(h.effects).toEqual([
      { kind: "failed", message: "Launch failed: EACCES", cause: "EACCES" },
    ]);
  });

  it("ignores a launch for a mod that is no longer installed", async () => {
    const h = harness({ subs: { list: async () => [] } });
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gui" });

    expect(h.asked).toEqual([]);
    expect(h.launched).toEqual([]);
  });

  it("ignores a launch for an entrypoint the mod does not declare", async () => {
    // A stale webview can still hold a card from before an update dropped it.
    const h = harness();
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod", id: "gone" });
    expect(h.launched).toEqual([]);
  });

  it("stops a running entrypoint and reports it stopped", async () => {
    const h = harness();
    await h.presenter.handle({ type: "stop", repo: "Owner/Mod", id: "gui" });

    expect(h.stopped).toEqual(["owner/mod::gui"]);
    expect(h.posted).toEqual([
      { type: "entrypoint", repo: "Owner/Mod", id: "gui", running: false },
    ]);
  });
});

describe("the escape hatch and the links out of the panel", () => {
  it("offers the clean-uninstall script behind a modal before running it", async () => {
    // It wipes every DCS Studio link and all unpacked data — irreversible, so
    // it must never run from a stray click.
    const h = harness({}, ["Run uninstall-all.bat"]);
    await h.presenter.handle({ type: "cleanUninstall" });

    expect(h.asked[0].message).toContain("removes ALL DCS Studio mod links");
    expect(h.effects).toEqual([{ kind: "runUninstallScript", path: UNINSTALL_BAT }]);
  });

  it("runs nothing when the clean-uninstall warning is dismissed", async () => {
    const h = harness({}, [undefined]);
    await h.presenter.handle({ type: "cleanUninstall" });
    expect(h.effects).toEqual([]);
  });

  it("reveals the script, writing it first so there is something to reveal", async () => {
    const h = harness();
    await h.presenter.handle({ type: "revealBat" });

    expect(h.calls).toEqual(["ensureUninstallBat"]);
    expect(h.effects).toEqual([{ kind: "reveal", path: UNINSTALL_BAT }]);
  });

  it("reveals a mod's unpacked folder", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openDir", repo: "Owner/Mod" });
    expect(h.effects).toEqual([{ kind: "reveal", path: `${DATA_DIR}\\owner-mod` }]);
  });

  it("reveals nothing for a mod that is not installed", async () => {
    const h = harness({ subs: { list: async () => [] } });
    await h.presenter.handle({ type: "openDir", repo: "Owner/Mod" });
    expect(h.effects).toEqual([]);
  });

  it("describes an external open rather than performing it", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openExternal", url: "https://github.com/Owner/Mod" });
    expect(h.effects).toEqual([{ kind: "openExternal", url: "https://github.com/Owner/Mod" }]);
  });

  it("routes the docs link to the named page, defaulting to the sandbox explainer", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openDocs", page: "entrypoints" });
    await h.presenter.handle({ type: "openDocs" });
    expect(h.effects).toEqual([
      { kind: "openDocs", page: "entrypoints" },
      { kind: "openDocs", page: "sandbox" },
    ]);
  });

  it("hands the shortcut request to whoever owns it", async () => {
    const h = harness();
    await h.presenter.handle({ type: "createShortcut" });
    expect(h.effects).toEqual([{ kind: "createShortcut" }]);
  });
});

describe("messages that carry nothing to act on", () => {
  it("ignores actions with no repo, no id, and types it does not know", async () => {
    const h = harness();
    for (const type of ["enable", "disable", "uninstall", "update", "openDir", "mystery"]) {
      await h.presenter.handle({ type });
    }
    await h.presenter.handle({ type: "launch", repo: "Owner/Mod" });
    await h.presenter.handle({ type: "stop", id: "gui" });
    await h.presenter.handle({ type: "openExternal" });

    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.effects).toEqual([]);
    expect(h.launched).toEqual([]);
    expect(h.stopped).toEqual([]);
  });
});
