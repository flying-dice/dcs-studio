import { errorText } from "../domain/errorText";
import { INSTALL_DIR, requiresOverwriteConfirm, type SkillInfo } from "../domain/skillsStatus";
import type { SkillsHostMessage, SkillsWebviewMessage } from "./webviewContract";

// The Agent Skills panel's decision logic, lifted out of the VS Code panel.
//
// The panel lists the skill files the extension ships and the state of their
// copies in the user's repo. `core/domain/skillsStatus.ts` already owned the
// status state machine and the "would this overwrite local edits" rule; what was
// welded to the panel are the decisions AROUND them:
//
//  - the one payload the webview renders everything from: the list, the install
//    directory it names on screen, and whether there is a repo to install into
//    at all;
//  - the OVERWRITE GATE, which is the only irreversible thing this panel does:
//    a `modified` skill is confirmed first, a fresh install and a version update
//    are not, and nothing but the confirm button's own label counts as a yes;
//  - that an install failure is REPORTED and the list still refreshed, while a
//    refused confirm refreshes nothing — the difference between "we tried and it
//    did not work" and "you said no";
//  - that a skill with no installed copy has nothing to open, so `open` is a
//    no-op rather than an error;
//  - the two different ways a file is opened, which is a decision and not a
//    detail: the installed copy is the user's to edit and takes a tab, the
//    bundled copy is a read-only peek and must not.
//
// None of it knows about VS Code. What stays in the shell
// (`src/skills/skillsPanel.ts`) is the panel, the `SkillsLibrary` adapter, the
// workspace-folder read, the modal, the two document opens and the toast.

/**
 * Something only the editor can do, described rather than done.
 *
 * `ref` is an OPAQUE handle to a file, minted by the shell and handed straight
 * back to it. Deliberately not a path: a skill installs into the workspace repo,
 * which may be remote or virtual, and flattening a `vscode.Uri` to a filesystem
 * path here would quietly break every workspace that is not on local disk.
 */
export type SkillsEffect =
  /**
   * A skill landed in the repo. The message names where, because "commit it" is
   * only actionable if the user knows what to commit; the shell offers to open
   * `ref` alongside it. The offer's button label is the shell's — unlike
   * `SkillsConfirm` below, nothing here compares against what was pressed.
   */
  | { kind: "installed"; message: string; ref: string }
  /** An install that could not be written. Already rendered for a human. */
  | { kind: "installFailed"; error: string }
  /** Open the installed copy for editing — the user's file, so it takes a tab. */
  | { kind: "openInstalled"; ref: string }
  /** Peek at the bundled copy. A preview tab: nothing here is editable. */
  | { kind: "viewBundled"; ref: string };

/**
 * A modal the user must accept before something irreversible happens.
 *
 * The label is data rather than a fixed string because the presenter is the half
 * that DECIDES whether the answer was a yes, and it can only do that if it knows
 * what it asked. Both of this panel's questions destroy something a user may
 * have written, so "anything that is not this exact button" has to mean no —
 * including the modal being dismissed.
 */
export interface SkillsConfirm {
  message: string;
  /** The single confirm button's label. Nothing else counts as a yes. */
  confirmLabel: string;
}

/** What one install put in the repo. */
export interface SkillsInstalled {
  /** The opaque handle for the installed file, for a later open. */
  ref: string;
  /** How to name that file to the user — workspace-relative, not absolute. */
  label: string;
}

/**
 * The message shapes the skills webview sends the host — the declared contract,
 * not a local restatement of it.
 */
export type SkillsInbound = SkillsWebviewMessage;

export interface SkillsPresenterDeps {
  /** Every bundled skill with its installed state in the current workspace. */
  list: () => Promise<readonly SkillInfo[]>;
  /**
   * Whether a folder is open. Read per push rather than once: the panel outlives
   * a workspace change, and the whole install story turns on this answer.
   */
  hasWorkspace: () => boolean;
  /** Copy the bundled skill into the repo, or throw if it cannot be written. */
  install: (id: string) => Promise<SkillsInstalled>;
  /** Delete the installed copy from the repo. */
  remove: (id: string) => Promise<void>;
  /** The installed copy's handle, or `undefined` when there is no copy at all. */
  installedRef: (id: string) => string | undefined;
  /** The bundled copy's handle. Always exists — it ships in the extension. */
  bundledRef: (id: string) => string;
  /** Ask the question, and report WHICH button came back (or none). */
  confirm: (question: SkillsConfirm) => Promise<string | undefined>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/skills.js` has no case for cannot be sent from here without
   * the contract being updated first.
   */
  post: (msg: SkillsHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: SkillsEffect) => void;
}

/** The confirm button for an overwrite, and the only answer that permits one. */
const OVERWRITE = "Overwrite";
/** The confirm button for a removal. */
const REMOVE = "Remove";

export class SkillsPresenter {
  constructor(private readonly deps: SkillsPresenterDeps) {}

  /**
   * The whole screen, in one message.
   *
   * Pushed on open, on every action that changed the repo, and whenever the
   * library reports the disk moved under it. `media/skills.js` re-renders from
   * scratch off this, so there is no partial update to get wrong — and it posts
   * `refresh` at load, which means this panel cannot lose its opening state to
   * the load race the way publish (card 22) and New Project (card 23) can.
   */
  async refresh(): Promise<void> {
    this.deps.post({
      type: "skills",
      skills: await this.deps.list(),
      installDir: INSTALL_DIR,
      hasWorkspace: this.deps.hasWorkspace(),
    });
  }

  async handle(msg: SkillsInbound): Promise<void> {
    switch (msg.type) {
      case "refresh":
        await this.refresh();
        break;
      case "install":
        if (msg.id) await this.install(msg.id);
        break;
      case "open":
        if (msg.id) this.openInstalled(msg.id);
        break;
      case "viewBundled":
        if (msg.id) this.deps.effect({ kind: "viewBundled", ref: this.deps.bundledRef(msg.id) });
        break;
      case "remove":
        if (msg.id) await this.remove(msg.id);
        break;
    }
  }

  /**
   * Install or update one skill.
   *
   * Installing over a locally-edited copy loses the user's changes and cannot be
   * undone, so that one case is confirmed. A skill the list does not know is
   * installed without asking — there is no state to consult, and so no edits to
   * protect. The refusal returns without refreshing: nothing changed, and a
   * redraw would only make it look as though something had.
   */
  private async install(id: string): Promise<void> {
    const state = (await this.deps.list()).find((s) => s.id === id);
    if (state && requiresOverwriteConfirm(state.status)) {
      const choice = await this.deps.confirm({
        message: `The installed "${id}" skill has local edits. Overwrite them with the bundled v${state.bundledVersion}?`,
        confirmLabel: OVERWRITE,
      });
      if (choice !== OVERWRITE) return;
    }
    try {
      const { ref, label } = await this.deps.install(id);
      this.deps.effect({
        kind: "installed",
        message: `Skill installed to ${label} — commit it with your repo.`,
        ref,
      });
    } catch (err) {
      this.deps.effect({ kind: "installFailed", error: errorText(err) });
    }
    // Outside the try on purpose: a failed install may still have left the repo
    // partly written, and the list is how the user finds out.
    await this.refresh();
  }

  /**
   * Open the installed copy — or do nothing, when there is not one.
   *
   * The absent handle is the no-folder case: with no repo there is nowhere for an
   * installed skill to be, and the button that sends this is only drawn for a
   * skill that reported an installed version. So a message that arrives anyway is
   * a stale document, and the honest answer to it is silence.
   */
  private openInstalled(id: string): void {
    const ref = this.deps.installedRef(id);
    if (!ref) return;
    this.deps.effect({ kind: "openInstalled", ref });
  }

  /** Remove one skill from the repo, once the user has said so in as many words. */
  private async remove(id: string): Promise<void> {
    const choice = await this.deps.confirm({
      message: `Remove the "${id}" skill from ${INSTALL_DIR}/${id} in your repo?`,
      confirmLabel: REMOVE,
    });
    if (choice !== REMOVE) return;
    await this.deps.remove(id);
    await this.refresh();
  }
}
