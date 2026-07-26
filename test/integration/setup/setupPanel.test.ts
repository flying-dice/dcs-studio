import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const files = new Set<string>();
vi.mock("fs", () => ({
  existsSync: (p: string) => {
    // Windows rejects some paths at the syscall level (too long, illegal
    // characters); model that as a throw so the panel's guard is exercised.
    if (p.includes("<illegal>")) throw new Error("EINVAL: invalid argument");
    return files.has(p);
  },
}));
vi.mock("os", () => ({ homedir: () => "C:\\Users\\fallback" }));

import * as vscode from "vscode";
import type { DetectService } from "../../../src/core/app/detectService";
import type { ArchivePort } from "../../../src/core/ports/archive";
import { SetupPanel } from "../../../src/setup/panel";

// The panel only ever asks the port where 7-Zip is; packing and extraction are
// the installer's business, never this panel's. It used to reach past the port
// into `adapters/node/sevenZip` and this suite mocked that module — the same
// coupling in the test that #61 removed from the source.
const archive = (): ArchivePort =>
  ({
    available: async () => sevenZipDetected || null,
  }) as unknown as ArchivePort;

// The first-run gate. Everything else in the extension resolves through the two
// paths chosen here, and a user who cannot get past this screen sees a product
// that appears not to work at all — so the emphasis is on what the panel offers
// when detection finds nothing, and on the settings it writes when saving.

let sevenZipDetected: string = "C:\\Program Files\\7-Zip\\7z.exe";
let savedCandidates: unknown[] = [];
let installCandidates: unknown[] = [];

function detect(): DetectService {
  return {
    detectSavedGames: async () => savedCandidates,
    detectGameInstalls: async () => installCandidates,
  } as unknown as DetectService;
}

const context = () =>
  ({
    extensionUri: vscode.Uri.file("C:\\ext"),
    subscriptions: [],
  }) as unknown as vscode.ExtensionContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  SetupPanel.show(context(), detect(), archive());
  await flush();
  return state.panels[state.panels.length - 1];
}

beforeEach(() => {
  resetVscode();
  files.clear();
  sevenZipDetected = "C:\\Program Files\\7-Zip\\7z.exe";
  savedCandidates = [{ path: "C:\\Users\\pilot\\Saved Games\\DCS", valid: true }];
  installCandidates = [{ path: "D:\\DCS World", valid: true }];
  process.env.USERPROFILE = "C:\\Users\\pilot";
  SetupPanel.current = undefined;
});

describe("initial state", () => {
  it("offers the detected candidates for both roles", async () => {
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];
    expect(init.savedCandidates).toEqual(savedCandidates);
    expect(init.installCandidates).toEqual(installCandidates);
  });

  it("reports empty strings, not undefined, when nothing is configured", async () => {
    // The webview binds these straight into inputs; undefined would render as
    // the literal text "undefined".
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      savedGames: "",
      gameInstall: "",
      dataDir: "",
      sevenZip: "",
    });
  });

  it("echoes configured paths back, trimmed", async () => {
    state.config["dcsStudio.savedGamesPath"] = "  D:\\SG\\DCS  ";
    state.config["dcsStudio.gameInstallPath"] = "  D:\\DCS World  ";
    state.config["dcsStudio.dataDir"] = "  E:\\ModData  ";
    state.config["dcsStudio.sevenZipPath"] = "  C:\\7z\\7z.exe  ";
    const panel = await show();

    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      savedGames: "D:\\SG\\DCS",
      gameInstall: "D:\\DCS World",
      dataDir: "E:\\ModData",
      sevenZip: "C:\\7z\\7z.exe",
    });
  });

  it("shows the default data dir so the placeholder is never blank", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].dataDirDefault).toBe(
      "C:\\Users\\pilot\\DCSStudio\\mods",
    );
  });

  it("falls back to the OS homedir for the default data dir when USERPROFILE is unset", async () => {
    delete process.env.USERPROFILE;
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].dataDirDefault).toContain("fallback");
  });

  it("reports the auto-detected 7-Zip, and an empty string when there is none", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].sevenZipDetected).toBe(
      "C:\\Program Files\\7-Zip\\7z.exe",
    );

    sevenZipDetected = undefined as unknown as string;
    SetupPanel.current = undefined;
    const second = await show();
    expect(second.webview.postedOfType("init")[0].sevenZipDetected).toBe("");
  });

  it("re-runs detection on redetect", async () => {
    const panel = await show();
    savedCandidates = [{ path: "E:\\Saved Games\\DCS", valid: true }];
    await panel.webview.receive({ type: "redetect" });
    await flush();

    expect(panel.webview.postedOfType("init")).toHaveLength(2);
    expect(panel.webview.postedOfType("init")[1].savedCandidates).toEqual(savedCandidates);
  });
});

describe("browsing", () => {
  it("asks for a folder for the userdata role and validates it by its Config dir", async () => {
    files.add("D:\\SG\\DCS\\Config");
    state.openDialogReplies.push(["D:\\SG\\DCS"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();

    expect(panel.webview.postedOfType("browsed")[0]).toEqual({
      type: "browsed",
      which: "saved",
      path: "D:\\SG\\DCS",
      valid: true,
    });
  });

  it("marks a userdata folder without a Config dir as invalid rather than refusing it", async () => {
    // The user may have picked the parent by mistake; showing invalid is more
    // useful than silently discarding the choice.
    state.openDialogReplies.push(["D:\\SG"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ valid: false });
  });

  it("validates an install folder by its DCS.exe", async () => {
    files.add("D:\\DCS World\\bin\\DCS.exe");
    state.openDialogReplies.push(["D:\\DCS World"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "install" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({
      which: "install",
      valid: true,
    });
  });

  it("accepts any folder for the data dir, which need not exist yet", async () => {
    state.openDialogReplies.push(["E:\\Brand New"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "data" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ valid: true });
  });

  it("browses for a file, not a folder, when picking 7z.exe", async () => {
    files.add("C:\\7z\\7z.exe");
    state.openDialogReplies.push(["C:\\7z\\7z.exe"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "sevenzip" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({
      which: "sevenzip",
      valid: true,
    });
  });

  it("reports a path the OS refuses to probe as invalid rather than crashing", async () => {
    state.openDialogReplies.push(["D:\\<illegal>\\DCS"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ valid: false });
  });

  it("posts nothing when the dialog is cancelled", async () => {
    state.openDialogReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();
    expect(panel.webview.postedOfType("browsed")).toHaveLength(0);
  });

  it("defaults to the userdata role when none is named", async () => {
    state.openDialogReplies.push(["D:\\SG\\DCS"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ which: undefined });
  });
});

describe("saving", () => {
  it("writes all four settings globally and confirms", async () => {
    // Global, not workspace: these paths describe the machine's DCS install,
    // and a per-folder value would silently stop applying elsewhere.
    const panel = await show();
    await panel.webview.receive({
      type: "save",
      savedGames: "D:\\SG\\DCS",
      gameInstall: "D:\\DCS World",
      dataDir: "E:\\ModData",
      sevenZip: "C:\\7z\\7z.exe",
    });
    await flush();

    expect(state.configUpdates.map((u) => [u.key, u.value, u.target])).toEqual([
      ["savedGamesPath", "D:\\SG\\DCS", 1],
      ["gameInstallPath", "D:\\DCS World", 1],
      ["dataDir", "E:\\ModData", 1],
      ["sevenZipPath", "C:\\7z\\7z.exe", 1],
    ]);
    expect(panel.webview.postedOfType("saved")).toHaveLength(1);
    expect(state.info).toEqual(["DCS paths saved."]);
  });

  it("clears a setting to an empty string when its field is omitted", async () => {
    // Clearing has to reach the settings file; leaving the old value would make
    // the "clear" button appear broken.
    const panel = await show();
    await panel.webview.receive({ type: "save" });
    await flush();
    expect(state.configUpdates.map((u) => u.value)).toEqual(["", "", "", ""]);
  });
});

describe("panel plumbing", () => {
  it("ignores unknown message types", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "mystery" });
    await flush();
    expect(state.configUpdates).toEqual([]);
  });

  it("reveals the existing panel rather than opening a second", async () => {
    await show();
    SetupPanel.show(context(), detect(), archive());
    expect(state.panels).toHaveLength(1);
  });

  it("clears the singleton on dispose", async () => {
    const panel = await show();
    panel.dispose();
    expect(SetupPanel.current).toBeUndefined();
  });
});
