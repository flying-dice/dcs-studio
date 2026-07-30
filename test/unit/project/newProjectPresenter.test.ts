import { beforeEach, describe, expect, it } from "vitest";
import type {
  NewProjectEffect,
  NewProjectPresenterDeps,
} from "../../../src/core/app/newProjectPresenter";
import { NewProjectPresenter } from "../../../src/core/app/newProjectPresenter";
import type { NewProjectHostMessage } from "../../../src/core/app/webviewContract";

// The New Project panel's decision logic, with no `vscode` anywhere — not even
// a double. Everything the panel could only do through the editor (the folder
// read, the two globalState keys, the picker, the scaffolds) arrives as a dep,
// so each rule below is asserted against the presenter's OWN output rather than
// against a mocked webview panel.
//
// The wiring that turns these posts and effects into VS Code calls is the
// integration suite's job (test/integration/project/newProjectPanel.test.ts).

const HOME = "C:\\Users\\pilot";
const FOLDER = "C:\\proj";
const NEW_ROOT = "C:\\Users\\pilot\\DCSStudio\\my-mod";

interface Harness {
  presenter: NewProjectPresenter;
  posted: NewProjectHostMessage[];
  effects: NewProjectEffect[];
  calls: string[];
  /**
   * Every dep call AND every effect, in the one order they happened.
   *
   * Two arrays cannot witness an order BETWEEN them, and here that order is the
   * rule: `openFolder` reloads the extension host, so a `setPendingOpen` moved
   * after it never lands. Swapping exactly those two passed a suite that
   * asserted `calls` and `effects` separately, which is why this exists.
   */
  timeline: string[];
  /** What `rememberLocation`/`setPendingOpen` last persisted. */
  stored: Map<string, string>;
}

let skipped: string[] = [];
let inPlaceFails: unknown;
let newFolderFails: unknown;
let picked: string | undefined;

function harness(over: Partial<NewProjectPresenterDeps> = {}): Harness {
  const posted: NewProjectHostMessage[] = [];
  const effects: NewProjectEffect[] = [];
  const calls: string[] = [];
  const timeline: string[] = [];
  const stored = new Map<string, string>();
  const call = (entry: string): void => {
    calls.push(entry);
    timeline.push(entry);
  };
  const deps: NewProjectPresenterDeps = {
    folder: () => undefined,
    homeDir: HOME,
    lastLocation: () => undefined,
    rememberLocation: async (location) => {
      call(`remember ${location}`);
      stored.set("last", location);
    },
    setPendingOpen: async (root) => {
      call(`pending ${root}`);
      stored.set("pending", root);
    },
    pickFolder: async (start) => {
      call(`pick ${start}`);
      return picked;
    },
    scaffoldInPlace: async (template, name, folder) => {
      call(`inPlace ${template}|${name}|${folder}`);
      if (inPlaceFails !== undefined) throw inPlaceFails;
      return { skipped };
    },
    scaffoldNewFolder: async (template, name, location) => {
      call(`newFolder ${template}|${name}|${location}`);
      if (newFolderFails !== undefined) throw newFolderFails;
      return { root: NEW_ROOT };
    },
    post: (msg) => posted.push(msg),
    effect: (e) => {
      effects.push(e);
      timeline.push(`effect ${e.kind}`);
    },
    ...over,
  };
  return { presenter: new NewProjectPresenter(deps), posted, effects, calls, timeline, stored };
}

beforeEach(() => {
  skipped = [];
  inPlaceFails = undefined;
  newFolderFails = undefined;
  picked = undefined;
});

describe("the opening render", () => {
  it("offers the template catalogue and the separator the preview joins with", () => {
    const h = harness();
    h.presenter.pushInit();
    const init = h.posted[0] as Extract<NewProjectHostMessage, { type: "init" }>;
    expect(init.type).toBe("init");
    expect(init.templates.length).toBeGreaterThan(0);
    expect(init.sep).toBe("\\");
  });

  it("reports the open folder and pre-names the project after it", () => {
    const h = harness({ folder: () => FOLDER });
    h.presenter.pushInit();
    expect(h.posted[0]).toMatchObject({ folder: FOLDER, name: "proj" });
  });

  it("offers the remembered location once a folder is open", () => {
    const h = harness({ folder: () => FOLDER, lastLocation: () => "E:\\Projects" });
    h.presenter.pushInit();
    expect(h.posted[0]).toMatchObject({ location: "E:\\Projects" });
  });

  it("falls back to a location under the home dir when nothing is remembered", () => {
    const h = harness({ folder: () => FOLDER });
    h.presenter.pushInit();
    expect(h.posted[0]).toMatchObject({ location: "C:\\Users\\pilot\\DCSStudio" });
  });

  it("reports no folder and an empty location when none is open", () => {
    const h = harness();
    h.presenter.pushInit();
    expect(h.posted[0]).toMatchObject({ folder: null, location: "", name: "" });
  });
});

describe("the boot handshake", () => {
  it("answers `ready` with the opening render, so a lost push is recoverable", async () => {
    // The panel pushes `init` from its constructor, before the webview document
    // has necessarily attached its `message` listener. This page renders ONLY
    // from `init`, so without an answerable handshake a lost push left a blank
    // document with no retry (card 24).
    const h = harness({ folder: () => FOLDER });
    await h.presenter.handle({ type: "ready" });
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ type: "init", folder: FOLDER });
  });

  it("replays `init` after the constructor push rather than refusing a second one", async () => {
    // Idempotence is the whole reason the unprompted push can stay as the first
    // chance: the host cannot tell whether the first `init` landed, so the answer
    // must be safe when it did.
    const h = harness({ folder: () => FOLDER });
    h.presenter.pushInit();
    await h.presenter.handle({ type: "ready" });
    expect(h.posted).toHaveLength(2);
    expect(h.posted[1]).toEqual(h.posted[0]);
    // A handshake is a request for state, not an action: nothing was scaffolded,
    // picked or persisted on the way.
    expect([...h.effects, ...h.calls]).toEqual([]);
  });

  it("re-reads the world, so the answer describes the folder open NOW", async () => {
    // `pushInit` reads its inputs afresh, which is what makes the replay a
    // re-render rather than a cached echo of a workspace that has since changed.
    let folder: string | undefined;
    const h = harness({ folder: () => folder });
    h.presenter.pushInit();
    folder = FOLDER;
    await h.presenter.handle({ type: "ready" });
    expect(h.posted[0]).toMatchObject({ folder: null });
    expect(h.posted[1]).toMatchObject({ folder: FOLDER });
  });
});

describe("browsing for a location", () => {
  it("opens the picker at the location the form is showing", async () => {
    picked = "E:\\Chosen";
    const h = harness({ lastLocation: () => "E:\\Remembered" });
    await h.presenter.handle({ type: "browse", location: "E:\\Typed" });
    expect(h.calls).toEqual(["pick E:\\Typed"]);
    expect(h.posted).toEqual([{ type: "browsed", path: "E:\\Chosen" }]);
  });

  it("falls back to the remembered location, then to the default", async () => {
    picked = "E:\\Chosen";
    const remembered = harness({ lastLocation: () => "E:\\Remembered" });
    await remembered.presenter.handle({ type: "browse" });
    expect(remembered.calls).toEqual(["pick E:\\Remembered"]);

    const bare = harness();
    await bare.presenter.handle({ type: "browse" });
    expect(bare.calls).toEqual(["pick C:\\Users\\pilot\\DCSStudio"]);
  });

  it("posts nothing when the picker is cancelled", async () => {
    picked = undefined;
    const h = harness();
    await h.presenter.handle({ type: "browse" });
    // Posting the start directory back would silently set a location the user
    // never chose.
    expect(h.posted).toEqual([]);
  });
});

describe("creating into a new folder", () => {
  it("scaffolds, remembers the location and flags the pending open before opening it", async () => {
    const h = harness();
    await h.presenter.handle({
      type: "create",
      template: "lua-mission",
      name: "my-mod",
      location: "C:\\Users\\pilot\\DCSStudio",
    });
    // Order is the whole rule: opening the folder reloads the extension host,
    // so BOTH persists must be done by the time that effect runs. Asserted on
    // the one timeline, because separate arrays cannot see the order between
    // the last persist and the effect that invalidates it.
    expect(h.timeline).toEqual([
      "newFolder lua-mission|my-mod|C:\\Users\\pilot\\DCSStudio",
      "remember C:\\Users\\pilot\\DCSStudio",
      `pending ${NEW_ROOT}`,
      "effect openFolder",
    ]);
    expect(h.effects).toEqual([{ kind: "openFolder", root: NEW_ROOT }]);
    // Nothing is posted to a form that is about to be reloaded away — card 25
    // removed the `created` message this used to assert. A push here would be
    // unobservable at best, and at worst would unlatch Create during teardown.
    expect(h.posted).toEqual([]);
  });

  it("substitutes empty strings for missing fields rather than throwing", async () => {
    const h = harness();
    await h.presenter.handle({ type: "create" });
    // The union declares what may ARRIVE; the scaffold's own validation is what
    // refuses an empty name.
    expect(h.calls[0]).toBe("newFolder ||");
  });

  it("reports a scaffold failure to the form and leaves the panel open", async () => {
    newFolderFails = new Error("Folder already exists and is not empty.");
    const h = harness();
    await h.presenter.handle({ type: "create", name: "my-mod", location: "C:\\x" });
    expect(h.posted).toEqual([
      { type: "error", message: "Folder already exists and is not empty." },
    ]);
    expect(h.effects).toEqual([]);
    expect(h.stored.has("pending")).toBe(false);
  });

  it("renders a non-Error failure", async () => {
    newFolderFails = "nope";
    const h = harness();
    await h.presenter.handle({ type: "create", name: "x", location: "C:\\x" });
    expect(h.posted).toEqual([{ type: "error", message: "nope" }]);
  });

  it("does not remember the location when the scaffold failed", async () => {
    newFolderFails = new Error("boom");
    const h = harness();
    await h.presenter.handle({ type: "create", name: "x", location: "C:\\x" });
    expect(h.stored.has("last")).toBe(false);
  });
});

describe("bootstrapping the open folder in place", () => {
  it("scaffolds in place, closes the panel and opens the manifest with no reload", async () => {
    const h = harness({ folder: () => FOLDER });
    await h.presenter.handle({
      type: "create",
      template: "lua-hook",
      name: "my-mod",
      inPlace: true,
    });
    expect(h.timeline).toEqual([
      `inPlace lua-hook|my-mod|${FOLDER}`,
      "effect close",
      "effect authorManifest",
    ]);
    // Nothing is posted here either: the panel is disposed on the way out
    // (card 25). `error` is the only reply a `create` has.
    expect(h.posted).toEqual([]);
    // No reload on this branch, so no breadcrumb is needed — and writing one
    // would open the manifest a second time on the next activation.
    expect(h.stored.has("pending")).toBe(false);
    expect(h.stored.has("last")).toBe(false);
  });

  it("names the files the template refused to overwrite", async () => {
    skipped = ["README.md", ".gitignore"];
    const h = harness({ folder: () => FOLDER });
    await h.presenter.handle({ type: "create", inPlace: true });
    expect(h.effects).toEqual([
      { kind: "close" },
      {
        kind: "notice",
        message: "Kept 2 existing file(s) the template also provides: README.md, .gitignore",
      },
      { kind: "authorManifest" },
    ]);
  });

  it("says nothing when the template overwrote nothing", async () => {
    const h = harness({ folder: () => FOLDER });
    await h.presenter.handle({ type: "create", inPlace: true });
    expect(h.effects.some((e) => e.kind === "notice")).toBe(false);
  });

  it("creates a new folder instead when in-place is asked for with no folder open", async () => {
    // The re-read at the moment of action, not the folder `init` was built from:
    // a window that closed its folder since the form rendered must not scaffold
    // into `undefined`.
    const h = harness({ folder: () => undefined });
    await h.presenter.handle({ type: "create", name: "my-mod", location: "C:\\x", inPlace: true });
    expect(h.calls[0]).toBe("newFolder |my-mod|C:\\x");
  });

  it("reports an in-place failure to the form and leaves the panel open", async () => {
    inPlaceFails = new Error("Template rendered an unsafe path.");
    const h = harness({ folder: () => FOLDER });
    await h.presenter.handle({ type: "create", inPlace: true });
    expect(h.posted).toEqual([{ type: "error", message: "Template rendered an unsafe path." }]);
    expect(h.effects).toEqual([]);
  });
});

describe("messages the contract does not declare", () => {
  it("are ignored entirely", async () => {
    const h = harness();
    await h.presenter.handle({ type: "mystery" } as never);
    expect([...h.posted, ...h.effects, ...h.calls]).toEqual([]);
  });
});
