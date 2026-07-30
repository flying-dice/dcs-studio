import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireConfigurationChanged,
  fireDocumentChanged,
  fireDocumentClosed,
  resetVscode,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());
vi.mock("os", () => ({ homedir: () => "C:\\Users\\fallback" }));
// The form resolves its roots through the same helpers the installer uses, and
// those probe the disk to choose between DCS and DCS.openbeta — so which paths
// "exist" is part of this panel's input.
let existing: string[] = [];
vi.mock("fs", () => ({ existsSync: (p: string) => existing.includes(p) }));

import * as vscode from "vscode";
import { installRoots } from "../../../src/adapters/vscode/installRoots";
import { ManifestFormPanel } from "../../../src/manifest/formPanel";

// The wiring `src/manifest/formPanel.ts` is now the only witness for: the panel
// itself, the one-form-per-DOCUMENT map (card 07 — this panel's teardown frees a
// map entry, not a `current` slot), the three workspace listeners with their
// per-document filters, the `WorkspaceEdit`, and the roots resolved through the
// real installer helpers over a mocked disk.
//
// The echo rule itself — that a change carrying the form's own text is not
// pushed back — is the presenter's, and is tested with no `vscode` at all in
// test/unit/manifest/manifestPresenter.test.ts. What is left here is that each
// listener REACHES the presenter, which no unit test can see.

const EXT = "C:\\ext";
const DOC_PATH = "C:\\proj\\dcs-studio.toml";

function document(fsPath = DOC_PATH, text = '[project]\nname = "my-mod"\n') {
  let current = text;
  return {
    uri: { fsPath, toString: () => `file://${fsPath}` },
    lineCount: current.split("\n").length,
    getText: () => current,
    setText: (next: string) => {
      current = next;
    },
  };
}

const context = () =>
  ({ extensionUri: vscode.Uri.file(EXT), subscriptions: [] }) as unknown as vscode.ExtensionContext;

const flush = () => new Promise((r) => setTimeout(r, 0));

function open(doc = document()) {
  ManifestFormPanel.openBeside(context(), doc as unknown as vscode.TextDocument, installRoots);
  return { doc, panel: state.panels[state.panels.length - 1] };
}

beforeEach(() => {
  // ManifestFormPanel keeps its open forms in a module-level map keyed by
  // document uri, so a panel left open by the previous test would be revealed
  // instead of a new one being created. Dispose before resetting state —
  // resetVscode() drops the panel list, and disposal is what frees the map.
  for (const panel of state.panels) panel.dispose();
  resetVscode();
  existing = [];
  process.env.USERPROFILE = "C:\\Users\\pilot";
});

describe("opening", () => {
  it("opens beside the editor, titled after the file", () => {
    const { panel } = open();
    expect(panel.title).toBe("Form: dcs-studio.toml");
    expect(panel.showOptions).toMatchObject({ preserveFocus: true });
  });

  it("bootstraps the webview with the document text, path and resolved roots", () => {
    state.config["dcsStudio.savedGamesPath"] = "D:\\SG\\DCS";
    state.config["dcsStudio.gameInstallPath"] = "D:\\DCS World";
    const { panel } = open();

    expect(panel.webview.html).toContain("window.__BOOTSTRAP__");
    const bootstrap = JSON.parse(
      /window\.__BOOTSTRAP__ = (\{.*?\});/s.exec(panel.webview.html)?.[1] ?? "{}",
    );
    expect(bootstrap.targetPath).toBe(DOC_PATH);
    expect(bootstrap.rawText).toContain("my-mod");
    expect(bootstrap.roots).toEqual({ savedGames: "D:\\SG\\DCS", gameInstall: "D:\\DCS World" });
  });

  it("defaults savedGames to the profile's Saved Games folder when unconfigured", () => {
    const { panel } = open();
    const bootstrap = JSON.parse(
      /window\.__BOOTSTRAP__ = (\{.*?\});/s.exec(panel.webview.html)?.[1] ?? "{}",
    );
    expect(bootstrap.roots.savedGames).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
    // Unset install stays an empty string — the form shows {GameInstall} as
    // unresolvable rather than resolving it against nothing.
    expect(bootstrap.roots.gameInstall).toBe("");
  });

  it("resolves an OpenBeta-only machine the way the installer will", () => {
    // The form's resolved-destination line is a promise about where a link
    // lands. This panel used to resolve {SavedGames} with its own copy of the
    // rule, which had no DCS.openbeta fallback — so an author on OpenBeta was
    // shown a folder the installer would never touch.
    existing = ["C:\\Users\\pilot\\Saved Games\\DCS.openbeta"];
    const { panel } = open();
    const bootstrap = JSON.parse(
      /window\.__BOOTSTRAP__ = (\{.*?\});/s.exec(panel.webview.html)?.[1] ?? "{}",
    );
    expect(bootstrap.roots.savedGames).toBe("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
  });

  it("falls back to the OS homedir when USERPROFILE is unset", () => {
    delete process.env.USERPROFILE;
    const { panel } = open();
    expect(panel.webview.html).toContain("fallback");
  });

  it("reveals the existing form rather than opening a second for the same document", () => {
    open();
    open();
    // Two forms bound to one document would fight over every keystroke.
    expect(state.panels).toHaveLength(1);
  });

  it("opens a separate form for a different document", () => {
    open();
    open(document("C:\\other\\dcs-studio.toml"));
    expect(state.panels).toHaveLength(2);
  });
});

describe("document to form", () => {
  it("pushes external edits into the form", async () => {
    const { doc, panel } = open();
    doc.setText('[project]\nname = "edited-in-editor"\n');
    fireDocumentChanged({ document: doc });
    await flush();

    expect(panel.webview.postedOfType("external")[0]).toMatchObject({
      rawText: '[project]\nname = "edited-in-editor"\n',
    });
  });

  it("ignores changes to other documents", async () => {
    const { panel } = open();
    fireDocumentChanged({ document: document("C:\\other\\dcs-studio.toml") });
    await flush();
    expect(panel.webview.postedOfType("external")).toHaveLength(0);
  });

  it("closes the form when its document's editor closes", async () => {
    const { doc, panel } = open();
    fireDocumentClosed(doc);
    await flush();
    expect(panel.disposed).toBe(true);
  });

  it("leaves the form open when a different document closes", async () => {
    const { panel } = open();
    fireDocumentClosed(document("C:\\other\\dcs-studio.toml"));
    await flush();
    expect(panel.disposed).toBe(false);
  });

  it("re-pushes the roots when DCS settings change", async () => {
    const { panel } = open();
    state.config["dcsStudio.savedGamesPath"] = "E:\\New\\DCS";
    fireConfigurationChanged("dcsStudio.savedGamesPath");
    await flush();

    expect(panel.webview.postedOfType("roots")[0]).toMatchObject({
      roots: { savedGames: "E:\\New\\DCS" },
    });
  });

  it("ignores configuration changes outside the extension's section", async () => {
    const { panel } = open();
    fireConfigurationChanged("editor.fontSize");
    await flush();
    expect(panel.webview.postedOfType("roots")).toHaveLength(0);
  });
});

describe("form to document", () => {
  it("replaces the whole document with the form's text", async () => {
    // The `WorkspaceEdit` is the shell's, and it is what makes save, dirty state
    // and undo belong to VS Code rather than to the form.
    const { panel } = open();
    await panel.webview.receive({ type: "edit", text: '[project]\nname = "new"\n' });

    expect(state.appliedEdits).toEqual([
      { uri: `file://${DOC_PATH}`, text: '[project]\nname = "new"\n' },
    ]);
  });
});

describe("disposal", () => {
  it("frees the document's slot so the form can be re-opened", () => {
    const { panel } = open();
    panel.dispose();

    open();
    expect(state.panels).toHaveLength(2);
  });
});
