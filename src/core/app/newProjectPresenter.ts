import { win32 as path } from "node:path";
import { errorText } from "../domain/errorText";
import { browseStart, initialForm } from "../domain/projectForm";
import { TEMPLATES } from "../domain/projectTemplates";
import type { NewProjectHostMessage, NewProjectWebviewMessage } from "./webviewContract";

// The New Project panel's decision logic, lifted out of the VS Code panel.
//
// The pure parts were already out: `core/domain/projectForm.ts` owns the
// opening form defaults and the picker's start directory, and
// `core/domain/scaffoldPlan.ts` owns every validation and the in-place
// keep-or-write plan. What was still welded to the panel is the part BETWEEN
// them — the sequencing that decides what the user ends up looking at:
//
//  - the init payload: the template catalogue, the path separator the webview
//    joins its live preview with, and the form defaults;
//  - **the in-place-versus-new-folder branch, re-read at the moment of action**
//    rather than trusted from the choice the form was rendered with — asking to
//    bootstrap "the open folder" with no folder open creates a new one instead;
//  - the two different endings the two branches have, in order: in place, the
//    panel closes and the manifest editor opens with no reload, and the files
//    the template refused to overwrite are named; into a new folder, the
//    remembered location and the pending-open breadcrumb are BOTH written
//    before the folder is opened, because opening it reloads the extension host
//    and anything not persisted by then is gone;
//  - a scaffold failure rendered into the form rather than closing it — the
//    only path where the panel survives a `create`.
//
// None of it knows about VS Code. What stays in the shell
// (`src/project/newProjectPanel.ts`) is the panel, the workspace-folder read,
// the `globalState` keys, the folder dialog, the two scaffold adapters, and the
// four effects below.

/** Something only the editor can do, described rather than done. */
export type NewProjectEffect =
  /** Close the panel. In place only — the flow is over and nothing reloads. */
  | { kind: "close" }
  /** Tell the user which existing files the template did not overwrite. */
  | { kind: "notice"; message: string }
  /** Open the manifest authoring form on the folder just bootstrapped. */
  | { kind: "authorManifest" }
  /** Open the new project folder, which reloads the extension host. */
  | { kind: "openFolder"; root: string };

/**
 * The message shapes the New Project webview sends the host — the declared
 * contract, not a local restatement of it.
 */
export type NewProjectInbound = NewProjectWebviewMessage;

/** What one scaffold run reports back. Narrower than `src/project/scaffold.ts`'s
 * `ScaffoldResult` on purpose: the in-place branch uses only `skipped` and the
 * new-folder branch only `root`, and each dep promises just its own half. */
export interface NewProjectPresenterDeps {
  /**
   * The open workspace folder to bootstrap in place, or `undefined` when there
   * is none (including a remote or virtual workspace, which cannot be
   * scaffolded into).
   *
   * A getter rather than a value — deliberately the opposite choice to
   * `PublishPresenter.root`. Publish resolves its root once because every later
   * decision must be about the same root; here the read at `create` time is a
   * GUARD: the form was rendered with whatever folder was open then, and the
   * host will not scaffold into a folder that is no longer there.
   */
  folder: () => string | undefined;
  /** The user's home directory, which the default location hangs off. */
  homeDir: string;
  /** The location last created into, remembered across sessions. */
  lastLocation: () => string | undefined;
  /** Remember `location` as the last one created into. */
  rememberLocation: (location: string) => Promise<void>;
  /**
   * Persist "open the manifest + form at `root` after the reload". Awaited
   * before the folder is opened, because opening it restarts the host.
   */
  setPendingOpen: (root: string) => Promise<void>;
  /** Ask the user for a folder, opening the picker at `start`. */
  pickFolder: (start: string) => Promise<string | undefined>;
  /** Bootstrap `folder` itself, keeping files it already has. */
  scaffoldInPlace: (
    template: string,
    name: string,
    folder: string,
  ) => Promise<{ skipped: string[] }>;
  /** Create `<location>/<name>` from `template` and report the root written. */
  scaffoldNewFolder: (
    template: string,
    name: string,
    location: string,
  ) => Promise<{ root: string }>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/newproject.js` has no case for cannot be sent from here
   * without the contract being updated first.
   */
  post: (msg: NewProjectHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: NewProjectEffect) => void;
}

export class NewProjectPresenter {
  constructor(private readonly deps: NewProjectPresenterDeps) {}

  /**
   * The opening render. Pushed unprompted, because the webview posts nothing at
   * load — see the `## Comments` on card 14 and card 23: this panel has no boot
   * handshake at all, so `init` is the one and only chance the form gets.
   */
  pushInit(): void {
    this.deps.post({
      type: "init",
      templates: TEMPLATES,
      // The webview joins `location` and `name` with this to show the live path
      // preview, so the host decides the separator rather than the document.
      sep: path.sep,
      ...initialForm(this.deps.folder(), this.deps.lastLocation(), this.deps.homeDir),
    });
  }

  async handle(msg: NewProjectInbound): Promise<void> {
    switch (msg.type) {
      case "browse": {
        const start = browseStart(msg.location, this.deps.lastLocation(), this.deps.homeDir);
        const picked = await this.deps.pickFolder(start);
        // A cancelled picker answers nothing at all: posting the start
        // directory back would silently change a location the user did not pick.
        if (picked) this.deps.post({ type: "browsed", path: picked });
        break;
      }
      case "create":
        // The union declares what may ARRIVE; a stale or crafted post may carry
        // none of these fields, and the scaffold's own validation is what
        // refuses an empty name or an unchosen location.
        await this.create(msg.template ?? "", msg.name ?? "", msg.location ?? "", !!msg.inPlace);
        break;
    }
  }

  private async create(
    template: string,
    name: string,
    location: string,
    inPlace: boolean,
  ): Promise<void> {
    try {
      // Re-read, not the value `init` was built from: "use the open folder" is
      // only an option while a folder is open, and one that closed since the
      // form rendered falls through to creating a new folder instead.
      const folder = this.deps.folder();
      if (inPlace && folder) {
        const { skipped } = await this.deps.scaffoldInPlace(template, name, folder);
        this.deps.post({ type: "created" });
        this.deps.effect({ kind: "close" });
        if (skipped.length) {
          this.deps.effect({
            kind: "notice",
            message: `Kept ${skipped.length} existing file(s) the template also provides: ${skipped.join(", ")}`,
          });
        }
        this.deps.effect({ kind: "authorManifest" });
        return;
      }

      const { root } = await this.deps.scaffoldNewFolder(template, name, location);
      await this.deps.rememberLocation(location);
      this.deps.post({ type: "created" });
      // Both persists happen BEFORE the folder is opened: opening it reloads the
      // extension host, and the pending-open breadcrumb is what makes the
      // manifest and form appear on the other side of that reload.
      await this.deps.setPendingOpen(root);
      this.deps.effect({ kind: "openFolder", root });
    } catch (err) {
      // The one path where the panel stays open — the user fixes the name or
      // the location and tries again.
      this.deps.post({ type: "error", message: errorText(err) });
    }
  }
}
