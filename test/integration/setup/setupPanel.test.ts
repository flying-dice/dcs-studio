import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const files = new Set<string>();
vi.mock("fs", () => ({
  existsSync: (p: string) => files.has(p),
}));
vi.mock("os", () => ({ homedir: () => "C:\\Users\\fallback" }));

import * as vscode from "vscode";
import type { DetectService } from "../../../src/core/app/detectService";
import type { ArchivePort } from "../../../src/core/ports/archive";
import { SetupPanel } from "../../../src/setup/panel";

// The Setup panel's WIRING — the part `SetupPresenter` cannot have, because it
// is the part that talks to VS Code. Everything the panel decides (what seeds
// the form, which role a browse is for, how a pick is validated, that saving
// writes all four settings) moved to `src/core/app/setupPresenter.ts` and is
// covered there with no editor double at all; this suite is the only witness for
// the seams between the two.
//
// The panel only ever asks the archive port where 7-Zip is; packing and
// extraction are the installer's business, never this panel's. It used to reach
// past the port into `adapters/node/sevenZip` and this suite mocked that module —
// the same coupling in the test that #61 removed from the source.
const archive = (): ArchivePort =>
  ({
    available: async () => sevenZipDetected || null,
  }) as unknown as ArchivePort;

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

describe("the panel", () => {
  it("renders a CSP document with the setup script and reveals rather than duplicating", async () => {
    const panel = await show();
    expect(panel.webview.html).toContain("setup.js");
    expect(panel.webview.html).toContain("Content-Security-Policy");
    SetupPanel.show(context(), detect(), archive());
    expect(state.panels).toHaveLength(1);
  });

  it("clears the singleton on dispose", async () => {
    // Card 07's teardown semantics, unchanged: this panel starts nothing that is
    // not a Disposable, so the whole teardown is releasing the singleton.
    const panel = await show();
    panel.dispose();
    expect(SetupPanel.current).toBeUndefined();
  });
});

describe("what the shell hands the presenter", () => {
  it("pushes the detected candidates and the configured paths on open", async () => {
    state.config["dcsStudio.savedGamesPath"] = "  D:\\SG\\DCS  ";
    state.config["dcsStudio.gameInstallPath"] = "D:\\DCS World";
    state.config["dcsStudio.dataDir"] = "E:\\ModData";
    state.config["dcsStudio.sevenZipPath"] = "C:\\7z\\7z.exe";
    const panel = await show();

    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      savedGames: "D:\\SG\\DCS",
      gameInstall: "D:\\DCS World",
      dataDir: "E:\\ModData",
      sevenZip: "C:\\7z\\7z.exe",
      sevenZipDetected: "C:\\Program Files\\7-Zip\\7z.exe",
      savedCandidates,
      installCandidates,
    });
  });

  it("derives the default data dir from USERPROFILE, falling back to the OS homedir", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].dataDirDefault).toBe(
      "C:\\Users\\pilot\\DCSStudio\\mods",
    );

    delete process.env.USERPROFILE;
    SetupPanel.current = undefined;
    const second = await show();
    expect(second.webview.postedOfType("init")[0].dataDirDefault).toContain("fallback");
  });

  it("routes a received message to the presenter", async () => {
    const panel = await show();
    savedCandidates = [{ path: "E:\\Saved Games\\DCS", valid: true }];
    await panel.webview.receive({ type: "redetect" });
    await flush();

    expect(panel.webview.postedOfType("init")).toHaveLength(2);
    expect(panel.webview.postedOfType("init")[1].savedCandidates).toEqual(savedCandidates);
  });
});

describe("the open dialog", () => {
  it("asks for a folder, with the presenter's label and no filter", async () => {
    files.add("D:\\SG\\DCS\\Config");
    state.openDialogReplies.push(["D:\\SG\\DCS"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();

    expect(state.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as DCS userdata",
      filters: undefined,
    });
    // The real `fs.existsSync` probe, reaching the presenter's verdict.
    expect(panel.webview.postedOfType("browsed")[0]).toEqual({
      type: "browsed",
      which: "saved",
      path: "D:\\SG\\DCS",
      valid: true,
    });
  });

  it("asks for an exe, not a folder, when the presenter wants a file", async () => {
    state.openDialogReplies.push(["C:\\7z\\7z.exe"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "sevenzip" });
    await flush();

    expect(state.openDialogOptions[0]).toMatchObject({
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { Executable: ["exe"] },
    });
  });

  it("reports a cancelled dialog as no choice at all", async () => {
    state.openDialogReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "browse", which: "saved" });
    await flush();
    expect(panel.webview.postedOfType("browsed")).toHaveLength(0);
  });
});

describe("saving", () => {
  it("writes all four settings globally and shows the notification", async () => {
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
});
