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

import * as vscode from "vscode";
import { ManifestFormPanel } from "../../../src/manifest/formPanel";

// The manifest form is two-way bound to a real text document, which makes the
// echo rule the whole game: an edit the form makes comes straight back through
// onDidChangeTextDocument, and re-pushing it would overwrite what the user is
// typing and steal focus mid-keystroke. That loop, and the one-panel-per-
// document rule, are what these tests pin.

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
  ManifestFormPanel.openBeside(context(), doc as unknown as vscode.TextDocument);
  return { doc, panel: state.panels[state.panels.length - 1] };
}

beforeEach(() => {
  // ManifestFormPanel keeps its open forms in a module-level map keyed by
  // document uri, so a panel left open by the previous test would be revealed
  // instead of a new one being created. Dispose before resetting state —
  // resetVscode() drops the panel list, and disposal is what frees the map.
  for (const panel of state.panels) panel.dispose();
  resetVscode();
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

  it("does not echo the form's own edit back into the form", async () => {
    // The critical case: the form writes, the write comes back as a document
    // change, and re-pushing it would clobber what the user is typing.
    const { doc, panel } = open();
    const next = '[project]\nname = "typed-in-form"\n';

    await panel.webview.receive({ type: "edit", text: next });
    doc.setText(next);
    fireDocumentChanged({ document: doc });
    await flush();

    expect(panel.webview.postedOfType("external")).toHaveLength(0);
  });

  it("resumes pushing once the document diverges from what the form wrote", async () => {
    const { doc, panel } = open();
    await panel.webview.receive({ type: "edit", text: "written-by-form" });
    doc.setText("someone-else-typed-this");
    fireDocumentChanged({ document: doc });
    await flush();

    expect(panel.webview.postedOfType("external")).toHaveLength(1);
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
    const { panel } = open();
    await panel.webview.receive({ type: "edit", text: '[project]\nname = "new"\n' });

    expect(state.appliedEdits).toEqual([
      { uri: `file://${DOC_PATH}`, text: '[project]\nname = "new"\n' },
    ]);
  });

  it("skips an edit identical to the document's current text", async () => {
    // Debounced form edits fire on every keystroke pause; writing an identical
    // buffer would mark the file dirty for nothing.
    const { doc, panel } = open();
    await panel.webview.receive({ type: "edit", text: doc.getText() });
    expect(state.appliedEdits).toEqual([]);
  });

  it("ignores an edit carrying no text", async () => {
    const { panel } = open();
    await panel.webview.receive({ type: "edit" });
    await panel.webview.receive({ type: "edit", text: 42 as unknown as string });
    expect(state.appliedEdits).toEqual([]);
  });

  it("ignores unknown message types", async () => {
    const { panel } = open();
    await panel.webview.receive({ type: "mystery", text: "x" });
    expect(state.appliedEdits).toEqual([]);
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
