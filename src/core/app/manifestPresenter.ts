import { errorText } from "../domain/errorText";
import type { BundlePreviewService } from "./bundlePreviewService";
import type {
  ManifestBootstrap,
  ManifestHostMessage,
  ManifestRoots,
  ManifestWebviewMessage,
} from "./webviewContract";

// The manifest authoring form's decision logic, lifted out of the VS Code panel.
//
// This panel is structurally unlike every other one covered so far, and the
// difference decides the shape of this file. The others are singletons — one
// console, one Publish panel, one Setup screen — so their presenter is one
// object for the whole session. The manifest form is keyed BY DOCUMENT in a Map
// (`src/manifest/formPanel.ts`, card 07's finding): a user may have two
// `dcs-studio.toml` files open and each gets its own form. So there is one
// presenter PER PANEL INSTANCE, constructed beside the panel and dying with it.
// That is not a stylistic choice — `lastWritten` below is the echo watermark for
// ONE document, and a presenter shared between two forms would let form A's own
// write suppress form B's external push, which is exactly the bug the watermark
// exists to prevent, moved one level up.
//
// What moved here:
//
//  - the ECHO RULE, which is the whole game for a two-way-bound panel: an edit
//    the form makes comes straight back as a document change, and re-pushing it
//    would overwrite what the user is typing and steal their caret mid-keystroke;
//  - the bootstrap payload — this panel's opening state crosses in the DOCUMENT
//    rather than as a message, so it is a value the presenter computes rather
//    than something it posts;
//  - the two guards on an inbound `edit` (not a string, or identical to what the
//    document already holds) — a no-op write would mark the file dirty for
//    nothing on every debounced keystroke pause;
//  - the roots pair, resolved through the ports the INSTALLER uses so the form's
//    resolved-destination preview cannot promise a folder nothing would use.
//
// None of it knows about VS Code. What stays in the shell is the panel, the map
// it lives in, the three `vscode.workspace` listeners and their per-document
// filters, and the `WorkspaceEdit` itself.

/**
 * The message shapes the manifest form sends the host — the declared contract,
 * not a local restatement of it.
 */
export type ManifestInbound = ManifestWebviewMessage;

export interface ManifestPresenterDeps {
  /**
   * The bound document's current full text. A function, not a value: this panel
   * is bound to a document the user is editing in a real editor beside it, so
   * every decision below has to be made against the text as it is NOW.
   */
  text: () => string;
  /** The document's path, shown in the form's header and its preview pane. */
  targetPath: string;
  /**
   * The DCS roots, resolved the way the INSTALLER resolves them rather than by a
   * second copy of the rule: the form's resolved-destination line is a promise
   * about where a link will land, and a preview that disagrees with the installer
   * is worse than none. (The copy this replaced skipped the
   * `Saved Games\DCS.openbeta` fallback, so on an OpenBeta-only machine it showed
   * the author a folder nothing would use.)
   *
   * Two thunks rather than the whole `InstallRootsPort`: the form has no business
   * with `dataDir`, which is where mods are unpacked. Read on every use rather
   * than captured, because the settings behind them change while the form is
   * open — that is what the `roots` push exists for.
   */
  installRoots: {
    savedGames: () => string;
    gameInstall: () => string | undefined;
  };
  /**
   * Replace the whole document with `text`. A `WorkspaceEdit` in the shell, so
   * the user's save, dirty state and undo stack stay VS Code's own.
   */
  write: (text: string) => Promise<void>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/manifest.js` has no case for cannot be sent from here without
   * the contract being updated first.
   */
  post: (msg: ManifestHostMessage) => void;
  /**
   * The project directory the form's `[[bundle]]` paths are relative to — the
   * manifest's own folder, which is what publish packages from.
   */
  projectRoot: string;
  /** Measures the archive the form's current entries would produce. */
  bundlePreview: BundlePreviewService;
  /** Open a page of the manual — the `[[bundle]]` label's deep link. */
  openDocs: (page: string) => void;
}

export class ManifestPresenter {
  /**
   * The last text WE wrote into the document. The echo watermark: the document
   * change our own write provokes carries exactly this, and pushing it back at
   * the form would clobber the field the user is typing in.
   *
   * Per instance, which is the point — see the note at the top of this file.
   *
   * Dropped as soon as the document diverges from it (`onDocumentChanged`): it
   * describes the document's CURRENT text or nothing, and a watermark outliving
   * that suppresses changes it has no claim on.
   */
  private lastWritten: string | null = null;

  constructor(private readonly deps: ManifestPresenterDeps) {}

  /**
   * The form's opening state.
   *
   * Unlike every other covered panel this is not a message: `media/manifest.js`
   * reads `window.__BOOTSTRAP__` synchronously at load, so the state crosses
   * inside the document the host renders. That is why this panel has no boot
   * handshake and — unlike publish (card 22) and New Project (card 23) — cannot
   * lose one to the load race.
   */
  bootstrap(): ManifestBootstrap {
    return {
      rawText: this.deps.text(),
      targetPath: this.deps.targetPath,
      roots: this.roots(),
    };
  }

  /**
   * The two roots as the form is told them. An unset game install becomes `""`
   * rather than travelling as `undefined`: the form draws `{GameInstall}` as
   * unresolvable-on-this-machine off exactly that emptiness, which is a different
   * warning from "this dest is wrong", and `undefined` would render as the
   * literal text "undefined" in the resolved line.
   */
  private roots(): ManifestRoots {
    return {
      savedGames: this.deps.installRoots.savedGames(),
      gameInstall: this.deps.installRoots.gameInstall() ?? "",
    };
  }

  /**
   * The bound document changed. Re-seed the form — unless this is the echo of
   * the form's own edit, in which case the form already holds it and pushing it
   * back would re-render the fields under the user's caret.
   */
  onDocumentChanged(): void {
    const rawText = this.deps.text();
    if (rawText === this.lastWritten) return;
    // The document has genuinely diverged from our last write, so that write can
    // never legitimately come back as an echo again — and a watermark kept past
    // this point swallows a LATER change that merely reproduces the same text.
    // The reachable case is undo-then-redo: the form writes T1, the user undoes
    // to T0 (pushed, here), then redoes back to T1 — which used to match the
    // stale watermark and be suppressed, leaving the form showing T0 while the
    // document held T1, until the next form edit quietly undid the redo
    // (card 27). Cleared BEFORE the push, so the push is the last word.
    this.lastWritten = null;
    this.deps.post({ type: "external", rawText });
  }

  /** The DCS paths changed under the form; its resolved dests are now stale. */
  pushRoots(): void {
    this.deps.post({ type: "roots", roots: this.roots() });
  }

  async handle(msg: ManifestInbound): Promise<void> {
    switch (msg.type) {
      case "edit":
        await this.edit(msg.text);
        break;
      case "bundlePreview":
        await this.previewBundle(msg);
        break;
      case "openDocs":
        if (typeof msg.page === "string" && msg.page) this.deps.openDocs(msg.page);
        break;
    }
  }

  /**
   * Which `bundlePreview` request is the current one. Bumped on arrival and
   * re-read after the measuring `await`, so a request overtaken while it was
   * walking the disk posts nothing at all.
   *
   * This is what buys the protocol its lack of a request id. The form asks on
   * every debounced change, the panel dispatches with `void handle(m)` rather
   * than serialising, and measuring a `target/` tree takes long enough that a
   * later, smaller request finishes first — so without this the form could
   * settle showing an older answer than one it had already been given, with
   * nothing on screen suggesting it was stale. Dropping the loser is right
   * rather than merely cheap: nobody wants the answer to a question they have
   * already changed.
   */
  private previewGeneration = 0;

  private async previewBundle(msg: {
    bundle?: { path?: string }[];
    name?: string;
    version?: string;
  }): Promise<void> {
    const generation = ++this.previewGeneration;
    let result: ManifestHostMessage;
    try {
      const preview = await this.deps.bundlePreview.preview(this.deps.projectRoot, {
        // Everything here crossed a process boundary from a document that may be
        // stale, so the shapes are rebuilt rather than trusted: a `bundle` that
        // is not an array, or a row whose `path` is not a string, is what a
        // crafted or half-updated post looks like and must not reach a
        // `path.join`.
        bundle: (Array.isArray(msg.bundle) ? msg.bundle : []).map((b) => ({
          path: typeof b?.path === "string" ? b.path : "",
        })),
        name: typeof msg.name === "string" ? msg.name : "",
        version: typeof msg.version === "string" ? msg.version : "",
      });
      result = { type: "bundlePreviewResult", preview };
    } catch (e) {
      result = { type: "bundlePreviewResult", error: errorText(e) };
    }
    if (generation !== this.previewGeneration) return;
    this.deps.post(result);
  }

  /**
   * Write the form's TOML into the document.
   *
   * Two refusals, both load-bearing. A non-string `text` is what a stale or
   * crafted post looks like and there is nothing to write. Text identical to the
   * document is the common case, not the exotic one: the form debounces and
   * re-emits the whole file on every keystroke pause, so writing an identical
   * buffer would mark the file dirty for nothing — and, worse, provoke a
   * document change whose echo the watermark would then swallow.
   */
  private async edit(text: string | undefined): Promise<void> {
    if (typeof text !== "string" || text === this.deps.text()) return;
    this.lastWritten = text;
    await this.deps.write(text);
  }
}
