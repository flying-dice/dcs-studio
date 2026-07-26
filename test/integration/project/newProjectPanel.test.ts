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

// The guided New Project flow. Creating into a new folder reloads the
// extension host, so the panel has to leave a breadcrumb in globalState before
// the reload or the manifest and form never appear — that handover, and the
// in-place branch that avoids the reload entirely, are the load-bearing parts.

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

describe("initial state", () => {
  it("offers the template catalogue and the platform separator", async () => {
    const panel = await show();
    const init = panel.webview.postedOfType("init")[0];
    expect((init.templates as unknown[]).length).toBeGreaterThan(0);
    // The webview builds the live path preview by joining with this.
    expect(init.sep).toBe("\\");
  });

  it("reports the open workspace folder and pre-names the project after it", async () => {
    // With a folder open the form offers "bootstrap this folder" as well as
    // creating a new one, so the folder and its basename both go across.
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({
      folder: "C:\\proj",
      name: "proj",
    });
  });

  it("offers the remembered location once a folder is open", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    globalState.set("dcs.lastProjectLocation", "E:\\Projects");
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ location: "E:\\Projects" });
  });

  it("offers the default location under the home dir when nothing is remembered", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0].location).toContain("C:\\Users\\pilot");
  });

  it("reports no folder and an empty location when none is open", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("init")[0]).toMatchObject({ folder: null, location: "" });
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
});

describe("browsing for a location", () => {
  it("posts the picked folder back", async () => {
    state.openDialogReplies.push(["E:\\Chosen"]);
    const panel = await show();
    await panel.webview.receive({ type: "browse", location: "E:\\Projects" });
    await flush();
    expect(panel.webview.postedOfType("browsed")[0]).toMatchObject({ path: "E:\\Chosen" });
  });

  it("posts nothing when the dialog is cancelled", async () => {
    state.openDialogReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "browse" });
    await flush();
    expect(panel.webview.postedOfType("browsed")).toHaveLength(0);
  });
});

describe("creating into a new folder", () => {
  it("scaffolds, records the location, flags the pending open and opens the folder", async () => {
    const panel = await show();
    await panel.webview.receive({
      type: "create",
      template: "mission-script",
      name: "my-mod",
      location: "C:\\Users\\pilot\\DCSStudio",
    });
    await flush();

    expect(scaffoldCalls).toEqual([
      {
        kind: "newFolder",
        template: "mission-script",
        name: "my-mod",
        target: "C:\\Users\\pilot\\DCSStudio",
      },
    ]);
    expect(globalState.get("dcs.lastProjectLocation")).toBe("C:\\Users\\pilot\\DCSStudio");
    // Opening the folder reloads the extension host, so the breadcrumb has to
    // be written first or the manifest and form never appear afterwards.
    expect(globalState.get(PENDING_OPEN_KEY)).toBe("C:\\Users\\pilot\\DCSStudio\\my-mod");
    expect(state.executedCommands.at(-1)?.command).toBe("vscode.openFolder");
    expect(panel.webview.postedOfType("created")).toHaveLength(1);
  });

  it("substitutes empty strings for missing fields rather than throwing", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "create" });
    await flush();
    expect(scaffoldCalls[0]).toMatchObject({ template: "", name: "", target: "" });
  });

  it("reports a scaffold failure to the form instead of closing it", async () => {
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

  it("renders a non-Error scaffold failure", async () => {
    newFolderImpl = async () => {
      throw "nope";
    };
    const panel = await show();
    await panel.webview.receive({ type: "create", name: "x", location: "C:\\x" });
    await flush();
    expect(panel.webview.postedOfType("error")[0]).toMatchObject({ message: "nope" });
  });
});

describe("bootstrapping the open folder in place", () => {
  it("scaffolds in place, closes the panel and opens the manifest without a reload", async () => {
    resetVscode({ workspaceFolders: ["C:\\proj"] });
    const panel = await show();
    await panel.webview.receive({
      type: "create",
      template: "mission-script",
      name: "my-mod",
      inPlace: true,
    });
    await flush();

    expect(scaffoldCalls[0]).toMatchObject({ kind: "inPlace", target: "C:\\proj" });
    expect(panel.disposed).toBe(true);
    expect(state.executedCommands.at(-1)?.command).toBe("dcs.manifest.author");
    // No reload, so no pending-open breadcrumb is needed.
    expect(globalState.get(PENDING_OPEN_KEY)).toBeUndefined();
  });

  it("names the files it refused to overwrite", async () => {
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

  it("falls back to the new-folder path when in-place is asked for with no folder open", async () => {
    const panel = await show();
    await panel.webview.receive({
      type: "create",
      name: "my-mod",
      location: "C:\\x",
      inPlace: true,
    });
    await flush();
    expect(scaffoldCalls[0]).toMatchObject({ kind: "newFolder" });
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
