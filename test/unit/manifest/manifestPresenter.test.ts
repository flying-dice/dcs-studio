import { beforeEach, describe, expect, it } from "vitest";
import { BundlePreviewService } from "../../../src/core/app/bundlePreviewService";
import type {
  ManifestInbound,
  ManifestPresenterDeps,
} from "../../../src/core/app/manifestPresenter";
import { ManifestPresenter } from "../../../src/core/app/manifestPresenter";
import type { ManifestHostMessage } from "../../../src/core/app/webviewContract";
import { MemFileSystem } from "../../support/memFileSystem";

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
  /** Pages handed to the docs deep link, in order. */
  docs: string[];
  /** The document, mutable the way a real one is while the form is open. */
  setText: (text: string) => void;
}

function harness(over: Partial<ManifestPresenterDeps> = {}): Harness {
  let text = TOML;
  const posted: ManifestHostMessage[] = [];
  const writes: string[] = [];
  const docs: string[] = [];
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
    projectRoot: "C:\\proj",
    bundlePreview: new BundlePreviewService(new MemFileSystem().seedFile("C:\\proj\\a.lua", "xy")),
    openDocs: (page) => docs.push(page),
    ...over,
  });
  return {
    presenter,
    posted,
    writes,
    docs,
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

  it("pushes a redo of the form's own write instead of mistaking it for the echo", async () => {
    // The watermark absorbs the ONE document change our own write provokes. Kept
    // past an undo it also swallows the redo, which reproduces the same text —
    // leaving the form rendering T0 while the document holds T1, so the next form
    // edit quietly undoes the redo (card 27).
    const h = harness();
    await h.presenter.handle({ type: "edit", text: "T1" });
    h.presenter.onDocumentChanged(); // the echo of our own write
    expect(h.posted).toEqual([]);

    h.setText("T0"); // the user hits undo
    h.presenter.onDocumentChanged();
    h.setText("T1"); // …and then redo
    h.presenter.onDocumentChanged();

    expect(h.posted).toEqual([
      { type: "external", rawText: "T0" },
      { type: "external", rawText: "T1" },
    ]);
  });

  it("still suppresses only the echo when the document has not moved", async () => {
    // Clearing on divergence must not weaken the rule the watermark exists for:
    // while the document still holds our write, every change carrying it is ours.
    const h = harness();
    await h.presenter.handle({ type: "edit", text: "written-by-form" });
    h.presenter.onDocumentChanged();
    h.presenter.onDocumentChanged();
    expect(h.posted).toEqual([]);
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

// ── The archive preview request ──────────────────────────────────────────────
//
// The form's one round trip, and the only place this presenter answers rather
// than announces. Everything here crossed a process boundary from a document
// that may be stale or crafted, so the guards are the subject — plus the
// generation counter, which is what buys the protocol its lack of a request id.

describe("the bundle preview request", () => {
  const request = (over: Record<string, unknown> = {}) =>
    ({
      type: "bundlePreview",
      bundle: [{ path: "a.lua" }],
      name: "m",
      version: "1",
      ...over,
    }) as ManifestInbound;

  it("answers with the archive the given entries would produce", async () => {
    const h = harness();
    await h.presenter.handle(request());
    expect(h.posted).toEqual([
      {
        type: "bundlePreviewResult",
        preview: expect.objectContaining({
          archiveName: "dcs-studio-m-1.7z",
          rows: [
            { path: "dcs-studio.toml", always: true, kind: "missing", files: 0, bytes: 0 },
            { path: "a.lua", always: false, kind: "file", files: 1, bytes: 2 },
          ],
        }),
      },
    ]);
  });

  it("rebuilds a bundle that is not an array rather than passing it on", async () => {
    // What a stale or crafted post looks like. Reaching `path.join` with a
    // non-string is the failure this refuses.
    const h = harness();
    await h.presenter.handle(request({ bundle: "Scripts" }));
    await h.presenter.handle(request({ bundle: [{ path: 7 }, {}, null] }));
    for (const posted of h.posted) {
      expect(posted).toMatchObject({ type: "bundlePreviewResult" });
      // Only the manifest survives: every supplied row rebuilt to a blank path,
      // and a blank path is not an entry.
      expect((posted as { preview: { rows: unknown[] } }).preview.rows).toHaveLength(1);
    }
  });

  it("treats absent name and version as unfilled boxes", async () => {
    const h = harness();
    await h.presenter.handle(request({ name: undefined, version: 12 }));
    expect(h.posted[0]).toMatchObject({
      preview: { archiveName: "dcs-studio-your-mod-0.1.0.7z" },
    });
  });

  it("reports a measurement that threw instead of leaving the last answer up", async () => {
    const h = harness({
      bundlePreview: {
        preview: async () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      } as unknown as BundlePreviewService,
    });
    await h.presenter.handle(request());
    expect(h.posted).toEqual([
      { type: "bundlePreviewResult", error: "EBUSY: resource busy or locked" },
    ]);
  });

  it("drops the answer to a request a newer one overtook", async () => {
    // The panel dispatches with `void handle(m)` rather than serialising, and
    // measuring a large tree takes long enough that a later, smaller request
    // finishes first. Without the generation counter the form would settle
    // showing an OLDER answer than one it had already been given, with nothing
    // on screen saying so.
    const gates: (() => void)[] = [];
    const h = harness({
      bundlePreview: {
        preview: () =>
          new Promise((resolve) => {
            gates.push(() => resolve({ rows: [], archiveName: "x" }));
          }),
      } as unknown as BundlePreviewService,
    });

    const slow = h.presenter.handle(request({ name: "slow" }));
    const fast = h.presenter.handle(request({ name: "fast" }));
    // The second request answers first; the first then finishes into the void.
    gates[1]();
    await fast;
    gates[0]();
    await slow;

    expect(h.posted).toHaveLength(1);
  });
});

describe("the docs deep link", () => {
  it("opens the page the label asked for", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openDocs", page: "mod-bundles" });
    expect(h.docs).toEqual(["mod-bundles"]);
  });

  it("opens nothing for a link with no page on it", async () => {
    const h = harness();
    await h.presenter.handle({ type: "openDocs" });
    await h.presenter.handle({ type: "openDocs", page: "" });
    await h.presenter.handle({ type: "openDocs", page: 7 } as unknown as ManifestInbound);
    expect(h.docs).toEqual([]);
  });
});
