import { beforeEach, describe, expect, it } from "vitest";
import type {
  SetupBrowseRequest,
  SetupEffect,
  SetupPresenterDeps,
} from "../../../src/core/app/setupPresenter";
import { SetupPresenter } from "../../../src/core/app/setupPresenter";
import type { SetupHostMessage } from "../../../src/core/app/webviewContract";
import type { DcsCandidate } from "../../../src/core/domain/dcsDetect";

// The first-run gate's decision logic, with no `vscode` double anywhere: the
// panel that used to own all of this is now a shell (`src/setup/panel.ts`), and
// what is left here is the part that decides what a user sees and what gets
// written to their settings. Everything else in the extension resolves through
// the two paths chosen on this screen, so a user who cannot get past it sees a
// product that appears not to work at all.

const SAVED_CAND: DcsCandidate = {
  path: "C:\\Users\\pilot\\Saved Games\\DCS",
  name: "DCS",
  valid: true,
  detail: "has Config",
};

const INSTALL_CAND: DcsCandidate = {
  path: "D:\\DCS World",
  name: "DCS World",
  valid: true,
  detail: "bin\\DCS.exe found",
};

interface Harness {
  presenter: SetupPresenter;
  posted: SetupHostMessage[];
  effects: SetupEffect[];
  /** Every browse request the presenter made, in order. */
  requests: SetupBrowseRequest[];
  /** Every setting written, as `[key, value]` in write order. */
  writes: [string, string][];
  /** The most recent `init`, which is the whole form's state. */
  init(): Extract<SetupHostMessage, { type: "init" }>;
}

/** Paths the fake probe reports as existing. Set per test. */
let files: Set<string>;
/** What the next `browse` resolves to; `null` is a cancelled dialog. */
let picked: string | null;

function harness(over: Partial<SetupPresenterDeps> = {}): Harness {
  const posted: SetupHostMessage[] = [];
  const effects: SetupEffect[] = [];
  const requests: SetupBrowseRequest[] = [];
  const writes: [string, string][] = [];
  const deps: SetupPresenterDeps = {
    detectSavedGames: async () => [SAVED_CAND],
    detectGameInstalls: async () => [INSTALL_CAND],
    settings: () => ({
      savedGamesPath: undefined,
      gameInstallPath: undefined,
      dataDir: undefined,
      sevenZipPath: undefined,
    }),
    saveSetting: async (key, value) => void writes.push([key, value]),
    defaultDataDir: () => "C:\\Users\\pilot\\DCSStudio\\mods",
    detectedSevenZip: async () => "C:\\Program Files\\7-Zip\\7z.exe",
    browse: async (request) => {
      requests.push(request);
      return picked;
    },
    exists: (p) => {
      // Windows rejects some paths at the syscall level (too long, illegal
      // characters); model that as a throw so the guard is exercised.
      if (p.includes("<illegal>")) throw new Error("EINVAL: invalid argument");
      return files.has(p);
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return {
    presenter: new SetupPresenter(deps),
    posted,
    effects,
    requests,
    writes,
    init: () => {
      const inits = posted.filter((m) => m.type === "init");
      return inits[inits.length - 1] as Extract<SetupHostMessage, { type: "init" }>;
    },
  };
}

beforeEach(() => {
  files = new Set();
  picked = null;
});

describe("the opening state", () => {
  it("offers the detected candidates for both roles", async () => {
    const h = harness();
    await h.presenter.refresh();
    expect(h.init().savedCandidates).toEqual([SAVED_CAND]);
    expect(h.init().installCandidates).toEqual([INSTALL_CAND]);
  });

  it("reports empty strings, not undefined, when nothing is configured", async () => {
    // The webview binds these straight into `value="…"`; undefined would render
    // as the literal text "undefined".
    const h = harness();
    await h.presenter.refresh();
    expect(h.init()).toMatchObject({
      savedGames: "",
      gameInstall: "",
      dataDir: "",
      sevenZip: "",
    });
  });

  it("echoes configured paths back, trimmed", async () => {
    const h = harness({
      settings: () => ({
        savedGamesPath: "  D:\\SG\\DCS  ",
        gameInstallPath: "  D:\\DCS World  ",
        dataDir: "  E:\\ModData  ",
        sevenZipPath: "  C:\\7z\\7z.exe  ",
      }),
    });
    await h.presenter.refresh();
    expect(h.init()).toMatchObject({
      savedGames: "D:\\SG\\DCS",
      gameInstall: "D:\\DCS World",
      dataDir: "E:\\ModData",
      sevenZip: "C:\\7z\\7z.exe",
    });
  });

  it("names the default data dir so the input's placeholder is never blank", async () => {
    const h = harness();
    await h.presenter.refresh();
    expect(h.init().dataDirDefault).toBe("C:\\Users\\pilot\\DCSStudio\\mods");
  });

  it("reports the auto-detected 7-Zip", async () => {
    const h = harness();
    await h.presenter.refresh();
    expect(h.init().sevenZipDetected).toBe("C:\\Program Files\\7-Zip\\7z.exe");
  });

  it("reports an empty string, not null, when 7-Zip was not found", async () => {
    // The webview renders "⚠ 7z not found" off the falsy value; null would work
    // by accident, but the declared payload is a string and the input binds it.
    const h = harness({ detectedSevenZip: async () => null });
    await h.presenter.refresh();
    expect(h.init().sevenZipDetected).toBe("");
  });

  it("reports an empty string when the archiver port answers undefined", async () => {
    const h = harness({ detectedSevenZip: async () => undefined });
    await h.presenter.refresh();
    expect(h.init().sevenZipDetected).toBe("");
  });

  it("re-runs both detections on redetect", async () => {
    let sweeps = 0;
    const h = harness({
      detectSavedGames: async () => {
        sweeps += 1;
        return [SAVED_CAND];
      },
    });
    await h.presenter.refresh();
    await h.presenter.handle({ type: "redetect" });
    expect(sweeps).toBe(2);
    expect(h.posted.filter((m) => m.type === "init")).toHaveLength(2);
  });
});

describe("browsing", () => {
  it("asks for a folder, labelled for the userdata role", async () => {
    picked = "D:\\SG\\DCS";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.requests[0]).toEqual({
      file: false,
      openLabel: "Use as DCS userdata",
      extensions: null,
    });
  });

  it("asks for a file, not a folder, when picking 7z.exe", async () => {
    // Asking for a folder here makes the right answer unpickable.
    picked = "C:\\7z\\7z.exe";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "sevenzip" });
    expect(h.requests[0]).toEqual({
      file: true,
      openLabel: "Use this 7z.exe",
      extensions: ["exe"],
    });
  });

  it.each([
    ["install", "Use as DCS install"],
    ["data", "Use as data dir"],
  ] as const)("labels the %s picker in the user's own terms", async (which, label) => {
    picked = "D:\\anything";
    const h = harness();
    await h.presenter.handle({ type: "browse", which });
    expect(h.requests[0].openLabel).toBe(label);
  });

  it("falls back to the userdata role when the message names none", async () => {
    // A stale or crafted post may carry no role at all; userdata is the panel's
    // first and most important field.
    picked = "D:\\SG\\DCS";
    const h = harness();
    await h.presenter.handle({ type: "browse" });
    expect(h.requests[0]).toMatchObject({ file: false, openLabel: "Use as DCS userdata" });
    // …and the role is echoed back exactly as it arrived, not as it was defaulted:
    // the webview has its own fallback and the two must not fight.
    expect(h.posted[0]).toEqual({
      type: "browsed",
      which: undefined,
      path: "D:\\SG\\DCS",
      valid: false,
    });
  });

  it("validates a userdata folder by its Config dir", async () => {
    files.add("D:\\SG\\DCS\\Config");
    picked = "D:\\SG\\DCS";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.posted[0]).toEqual({
      type: "browsed",
      which: "saved",
      path: "D:\\SG\\DCS",
      valid: true,
    });
  });

  it("marks a userdata folder without a Config dir invalid rather than refusing it", async () => {
    // The user may have picked the parent by mistake; showing invalid is more
    // useful than silently discarding the choice.
    picked = "D:\\SG";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.posted[0]).toMatchObject({ valid: false });
  });

  it("validates an install folder by its bin\\DCS.exe", async () => {
    files.add("D:\\DCS World\\bin\\DCS.exe");
    picked = "D:\\DCS World";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "install" });
    expect(h.posted[0]).toMatchObject({ which: "install", valid: true });
  });

  it("accepts any folder for the data dir, which need not exist yet", async () => {
    // The role has no witness path at all — the installer creates the folder.
    picked = "E:\\Brand New";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "data" });
    expect(h.posted[0]).toMatchObject({ valid: true });
  });

  it("validates a 7z pick by the file itself", async () => {
    files.add("C:\\7z\\7z.exe");
    picked = "C:\\7z\\7z.exe";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "sevenzip" });
    expect(h.posted[0]).toMatchObject({ which: "sevenzip", valid: true });
  });

  it("reports a path the OS refuses to probe as invalid rather than crashing", async () => {
    picked = "D:\\<illegal>\\DCS";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.posted[0]).toMatchObject({ valid: false });
  });

  it("posts nothing when the dialog is cancelled", async () => {
    // Not a choice: the form keeps whatever the user had typed.
    picked = null;
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.posted).toEqual([]);
  });

  it("posts a pick of the empty string rather than treating it as a cancellation", async () => {
    // `""` is falsy but it is still an answer; only `null` means "cancelled",
    // and conflating them would silently drop a reply the shell did make.
    picked = "";
    const h = harness();
    await h.presenter.handle({ type: "browse", which: "saved" });
    expect(h.posted).toHaveLength(1);
  });
});

describe("saving", () => {
  it("writes all four settings under their real setting ids, then confirms", async () => {
    const h = harness();
    await h.presenter.handle({
      type: "save",
      savedGames: "D:\\SG\\DCS",
      gameInstall: "D:\\DCS World",
      dataDir: "E:\\ModData",
      sevenZip: "C:\\7z\\7z.exe",
    });
    expect(h.writes).toEqual([
      ["savedGamesPath", "D:\\SG\\DCS"],
      ["gameInstallPath", "D:\\DCS World"],
      ["dataDir", "E:\\ModData"],
      ["sevenZipPath", "C:\\7z\\7z.exe"],
    ]);
    expect(h.posted).toEqual([{ type: "saved" }]);
    expect(h.effects).toEqual([{ kind: "notify", message: "DCS paths saved." }]);
  });

  it("clears a setting to an empty string when its field is omitted", async () => {
    // Clearing has to reach the settings file; leaving the old value would make
    // the cleared box look like a broken button.
    const h = harness();
    await h.presenter.handle({ type: "save" });
    expect(h.writes.map(([, v]) => v)).toEqual(["", "", "", ""]);
  });

  it("acknowledges only after every write has landed", async () => {
    // The webview flashes "Saved ✓" off this, and a confirmation that races the
    // writes would claim success for settings still in flight.
    const order: string[] = [];
    const h = harness({
      saveSetting: async (key) => {
        await Promise.resolve();
        order.push(key);
      },
    });
    await h.presenter.handle({ type: "save" });
    order.push("acked");
    expect(order).toEqual([
      "savedGamesPath",
      "gameInstallPath",
      "dataDir",
      "sevenZipPath",
      "acked",
    ]);
    expect(h.posted).toEqual([{ type: "saved" }]);
  });
});

describe("messages the contract does not declare", () => {
  it("does nothing at all", async () => {
    const h = harness();
    await h.presenter.handle({ type: "mystery" } as never);
    expect(h.posted).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});
