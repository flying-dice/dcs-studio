import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());
vi.mock("os", () => ({ homedir: () => "C:\\Users\\pilot" }));

const scaffoldCalls: { kind: string; template: string; name: string; target: string }[] = [];
let newFolderImpl: () => Promise<{ root: string; skipped: string[] }> = async () => ({
  root: "C:\\Users\\pilot\\DCSStudio\\my-mod",
  skipped: [],
});
let inPlaceImpl: () => Promise<{ root: string; skipped: string[] }> = async () => ({
  root: "C:\\proj",
  skipped: [],
});

vi.mock("../../../src/project/scaffold", () => ({
  scaffoldNewFolder: async (_uri: unknown, template: string, name: string, location: string) => {
    scaffoldCalls.push({ kind: "newFolder", template, name, target: location });
    return newFolderImpl();
  },
  scaffoldInPlace: async (_uri: unknown, template: string, name: string, folder: string) => {
    scaffoldCalls.push({ kind: "inPlace", template, name, target: folder });
    return inPlaceImpl();
  },
}));

import * as vscode from "vscode";
import { NewProjectPanel, PENDING_OPEN_KEY } from "../../../src/project/newProjectPanel";

// The New Project panel's WIRING — the shell around
// `src/core/app/newProjectPresenter.ts`, which is where every decision now
// lives and is tested with no `vscode` at all
// (test/unit/project/newProjectPresenter.test.ts).
//
// What only this layer can witness: the workspace-folder read and what counts
// as a folder, the two `globalState` keys by name, the folder dialog's options,
// the four presenter effects becoming real editor calls (and the ORDER of the
// two that matter — the pending-open breadcrumb is written before the reload),
// and card 07's teardown.

const globalState = new Map<string, unknown>();

const context = () =>
  ({
    extensionUri: vscode.Uri.file("C:\\ext"),
    subscriptions: [],
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => {
        globalState.set(key, value);
      },
    },
  }) as unknown as vscode.ExtensionContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  NewProjectPanel.show(context());
  await flush();
  return state.panels[state.panels.length - 1];
}

beforeEach(() => {
  resetVscode();
  globalState.clear();
  scaffoldCalls.length = 0;
  newFolderImpl = async () => ({ root: "C:\\Users\\pilot\\DCSStudio\\my-mod", skipped: [] });
  inPlaceImpl = async () => ({ root: "C:\\proj", skipped: [] });
  NewProjectPanel.current = undefined;
});

describe("the opening push", () => {
  it("reaches the webview unprompted, with the catalogue and the separator", async () => {
    // The webview posts nothing at load, so this push is the whole handshake
    // (card 23) — if the panel did not send it from its constructor the form
    // would never render at all.
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];
    expect((init.templates as unknown[]).length).toBeGreaterThan(0);
    expect(init.sep).toBe("\\");
  });

  it("reports the open workspace folder", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      folder: "C:\\proj",
      name: "proj",
    });
  });

  it("treats a non-file workspace as no folder at all", async () => {
    // A remote or virtual workspace cannot be scaffolded into.
    resetVscode();
    state.workspaceFolders = [
      { uri: { fsPath: "vscode-vfs://x/y", scheme: "vscode-vfs" }, name: "v", index: 0 },
    ] as never;
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ folder: null });
  });

  it("reads the remembered location out of globalState by name", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    globalState.set("dcs.lastProjectLocation", "E:\\Projects");
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ location: "E:\\Projects" });
  });
});

describe("the folder dialog", () => {
  it("asks for a single folder, opening where the presenter said", async () => {
    state.openDialogReplies.push(["E:\\Chosen"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", location: "E:\\Projects" });
    await flush();

    expect(state.openDialogOptions[0]).toMatchObject({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as location",
    });
    expect(state.openDialogOptions[0].defaultUri?.fsPath).toBe("E:\\Projects");
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ path: "E:\\Chosen" });
  });

  it("hands back nothing when the dialog is cancelled", async () => {
    state.openDialogReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "browse" });
    await flush();
    expect(panel.webview.postedOfType("browsed")).toHaveLength(0);
  });
});

describe("creating into a new folder", () => {
  it("scaffolds through the adapter, writes both keys and then opens the folder", async () => {
    const panel = await show();
    await panel.webview.receive({
      type: "create",
      template: "lua-mission",
      name: "my-mod",
      location: "C:\\Users\\pilot\\DCSStudio",
    });
    await flush();

    expect(scaffoldCalls).toEqual([
      {
        kind: "newFolder",
        template: "lua-mission",
        name: "my-mod",
        target: "C:\\Users\\pilot\\DCSStudio",
      },
    ]);
    expect(globalState.get("dcs.lastProjectLocation")).toBe("C:\\Users\\pilot\\DCSStudio");
    // Opening the folder reloads the extension host, so the breadcrumb has to
    // be written first or the manifest and form never appear afterwards.
    expect(globalState.get(PENDING_OPEN_KEY)).toBe("C:\\Users\\pilot\\DCSStudio\\my-mod");
    const opened = state.executedCommands[state.executedCommands.length - 1];
    expect(opened.command).toBe("vscode.openFolder");
    expect((opened.args[0] as vscode.Uri).fsPath).toBe("C:\\Users\\pilot\\DCSStudio\\my-mod");
    expect(opened.args[1]).toEqual({ forceNewWindow: false });
  });

  it("leaves the panel open when the scaffold adapter throws", async () => {
    newFolderImpl = async () => {
      throw new Error("Folder already exists and is not empty.");
    };
    const panel = await show();
    await panel.webview.receive({ type: "create", name: "my-mod", location: "C:\\x" });
    await flush();

    expect(panel.webview.postedOfType("error")[0]).toMatchObject({
      message: "Folder already exists and is not empty.",
    });
    expect(panel.disposed).toBe(false);
    expect(globalState.get(PENDING_OPEN_KEY)).toBeUndefined();
  });
});

describe("bootstrapping the open folder in place", () => {
  it("closes the panel and opens the manifest form, with no reload", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    await panel.webview.receive({ type: "create", name: "my-mod", inPlace: true });
    await flush();

    expect(scaffoldCalls[0]).toMatchObject({ kind: "inPlace", target: "C:\\proj" });
    expect(panel.disposed).toBe(true);
    expect(state.executedCommands.at(-1)?.command).toBe("dcs.manifest.author");
    expect(globalState.get(PENDING_OPEN_KEY)).toBeUndefined();
  });

  it("shows the kept-files notice as an information message", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    inPlaceImpl = async () => ({ root: "C:\\proj", skipped: ["README.md", ".gitignore"] });
    const panel = await show();
    await panel.webview.receive({ type: "create", inPlace: true });
    await flush();

    expect(state.info[0]).toContain("Kept 2 existing file(s)");
    expect(state.info[0]).toContain("README.md, .gitignore");
  });

  it("says nothing when the template overwrote nothing", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    await panel.webview.receive({ type: "create", inPlace: true });
    await flush();
    expect(state.info).toEqual([]);
  });
});

describe("panel plumbing", () => {
  it("ignores unknown message types", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "mystery" });
    await flush();
    expect(scaffoldCalls).toEqual([]);
  });

  it("reveals the existing panel rather than opening a second", async () => {
    await show();
    NewProjectPanel.show(context());
    expect(state.panels).toHaveLength(1);
  });

  it("clears the singleton on dispose", async () => {
    const panel = await show();
    panel.dispose();
    expect(NewProjectPanel.current).toBeUndefined();
  });
});
