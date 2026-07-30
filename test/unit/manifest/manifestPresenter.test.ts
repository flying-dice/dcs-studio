import { beforeEach, describe, expect, it } from "vitest";
import type { ManifestPresenterDeps } from "../../../src/core/app/manifestPresenter";
import { ManifestPresenter } from "../../../src/core/app/manifestPresenter";
import type { ManifestHostMessage } from "../../../src/core/app/webviewContract";

// The manifest form's host half, with no `vscode` double anywhere.
//
// The panel is two-way bound to a document the user is also editing in a real
// editor, which makes the ECHO RULE the whole game: an edit the form makes comes
// straight back as a document change, and re-pushing it would re-render the
// fields under the user's caret. The other thing these tests pin is the reason
// the presenter is per-panel rather than per-session — the watermark that
// implements the echo rule is one document's, and two forms must not share it.

const TOML = '[project]\nname = "my-mod"\n';
const PATH = "C:\\proj\\dcs-studio.toml";

interface Harness {
  presenter: ManifestPresenter;
  posted: ManifestHostMessage[];
  writes: string[];
  /** The document, mutable the way a real one is while the form is open. */
  setText: (text: string) => void;
}

function harness(over: Partial<ManifestPresenterDeps> = {}): Harness {
  let text = TOML;
  const posted: ManifestHostMessage[] = [];
  const writes: string[] = [];
  const presenter = new ManifestPresenter({
    text: () => text,
    targetPath: PATH,
    installRoots: {
      savedGames: () => "C:\\Users\\pilot\\Saved Games\\DCS",
      gameInstall: () => "C:\\DCS World",
    },
    // The real shell's WorkspaceEdit lands in the document, so a write that does
    // not update `text` would make every echo test pass for the wrong reason.
    write: async (next) => {
      writes.push(next);
      text = next;
    },
    post: (msg) => posted.push(msg),
    ...over,
  });
  return {
    presenter,
    posted,
    writes,
    setText: (next) => {
      text = next;
    },
  };
}

describe("the bootstrap payload", () => {
  it("carries the document's text, its path and the resolved roots", () => {
    expect(harness().presenter.bootstrap()).toEqual({
      rawText: TOML,
      targetPath: PATH,
      roots: { savedGames: "C:\\Users\\pilot\\Saved Games\\DCS", gameInstall: "C:\\DCS World" },
    });
  });

  it("reads the document at the moment the form opens, not at construction", () => {
    // The shell renders the html after wiring the presenter, and a manifest can
    // be edited between the two.
    const h = harness();
    h.setText("[project]\nname = 'later'\n");
    expect(h.presenter.bootstrap().rawText).toBe("[project]\nname = 'later'\n");
  });

  it("reports an unconfigured game install as the empty string", () => {
    // Not `undefined`: the form draws {GameInstall} as unresolvable off exactly
    // this emptiness, and undefined would render as the literal text "undefined".
    const h = harness({
      installRoots: { savedGames: () => "C:\\SG\\DCS", gameInstall: () => undefined },
    });
    expect(h.presenter.bootstrap().roots.gameInstall).toBe("");
  });
});

describe("document to form", () => {
  it("pushes the document's new text at the form", () => {
    const h = harness();
    h.setText("[project]\nname = 'edited-in-editor'\n");
    h.presenter.onDocumentChanged();
    expect(h.posted).toEqual([
      { type: "external", rawText: "[project]\nname = 'edited-in-editor'\n" },
    ]);
  });

  it("does not echo the form's own edit back into the form", async () => {
    // The critical case: the form writes, the write comes back as a document
    // change, and re-pushing it would clobber what the user is typing.
    const h = harness();
    await h.presenter.handle({ type: "edit", text: "written-by-form" });
    h.presenter.onDocumentChanged();
    expect(h.posted).toEqual([]);
  });

  it("resumes pushing once the document diverges from what the form wrote", async () => {
    const h = harness();
    await h.presenter.handle({ type: "edit", text: "written-by-form" });
    h.setText("someone-else-typed-this");
    h.presenter.onDocumentChanged();
    expect(h.posted).toEqual([{ type: "external", rawText: "someone-else-typed-this" }]);
  });

  it("keeps each document's watermark to itself", () => {
    // Why there is one presenter per PANEL and not one per session: this panel is
    // keyed by document in a Map, so two manifests can be open at once. A shared
    // watermark would let form A's write suppress form B's external push — the
    // clobbering bug the watermark exists to prevent, one level up.
    const a = harness();
    const b = harness();
    void a.presenter.handle({ type: "edit", text: "written-by-a" });
    b.setText("written-by-a");
    b.presenter.onDocumentChanged();
    expect(b.posted).toEqual([{ type: "external", rawText: "written-by-a" }]);
  });
});

describe("the roots push", () => {
  it("re-reads the settings rather than replaying the ones it opened with", () => {
    let install: string | undefined = "C:\\DCS World";
    const h = harness({
      installRoots: { savedGames: () => "C:\\SG\\DCS", gameInstall: () => install },
    });
    h.presenter.bootstrap();
    install = "E:\\DCS World OpenBeta";
    h.presenter.pushRoots();
    expect(h.posted).toEqual([
      {
        type: "roots",
        roots: { savedGames: "C:\\SG\\DCS", gameInstall: "E:\\DCS World OpenBeta" },
      },
    ]);
  });

  it("clears a game install that was un-set, rather than leaving the old path", () => {
    const h = harness({
      installRoots: { savedGames: () => "C:\\SG\\DCS", gameInstall: () => undefined },
    });
    h.presenter.pushRoots();
    expect(h.posted).toEqual([
      { type: "roots", roots: { savedGames: "C:\\SG\\DCS", gameInstall: "" } },
    ]);
  });
});

describe("form to document", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("replaces the whole document with the form's text", async () => {
    await h.presenter.handle({ type: "edit", text: '[project]\nname = "new"\n' });
    expect(h.writes).toEqual(['[project]\nname = "new"\n']);
  });

  it("skips an edit identical to the document's current text", async () => {
    // Not an edge case: the form debounces and re-emits the WHOLE file on every
    // keystroke pause, so writing an identical buffer would mark the file dirty
    // for nothing — and provoke a change whose echo the watermark then swallows.
    await h.presenter.handle({ type: "edit", text: TOML });
    expect(h.writes).toEqual([]);
  });

  it("does not arm the watermark on an edit it refused to write", async () => {
    // The refusal above must not leave the presenter thinking it wrote that text:
    // if it did, a real external edit BACK to it would be silently swallowed.
    await h.presenter.handle({ type: "edit", text: TOML });
    h.presenter.onDocumentChanged();
    expect(h.posted).toEqual([{ type: "external", rawText: TOML }]);
  });

  it("ignores an edit carrying no text", async () => {
    await h.presenter.handle({ type: "edit" });
    await h.presenter.handle({ type: "edit", text: 42 as unknown as string });
    expect(h.writes).toEqual([]);
  });

  it("ignores a message type the contract does not declare", async () => {
    await h.presenter.handle({ type: "mystery" } as unknown as { type: "edit" });
    expect(h.writes).toEqual([]);
    expect(h.posted).toEqual([]);
  });
});
