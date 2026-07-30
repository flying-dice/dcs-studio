import { type DualBridgeStatus, displayTime } from "../domain/bridgeProtocol";
import type { SkillInfo } from "../domain/skillsStatus";
import type { NavHostMessage, NavWebviewMessage } from "./webviewContract";

// The sidebar's decision logic, lifted out of the VS Code view provider.
//
// This is the eleventh and last webview to get a presenter, and the only one
// that is a `WebviewView` rather than a panel. Card 07 found that the sidebar
// does NOT fit the panel teardown scaffold — its lifetime is per
// `resolveWebviewView`, and its subscriptions are named fields re-created on
// each resolve rather than a disposables array a panel owns. That finding is
// about DISPOSAL, and this presenter takes no part in disposal: it is a
// `vscode`-free object the provider owns, and the hand-rolled teardown in
// `src/nav/navView.ts` is untouched. Two different questions with two different
// answers — see card 14's journal.
//
// What the sidebar decides, and what therefore lives here:
//
//  - the COARSE STATUS COLLAPSE. The bridge status is two independent bridges;
//    the footer is one dot, one label and one clock. Which of the two times to
//    show is `displayTime`'s rule already, but "connected means EITHER is up" is
//    the sidebar's own and was welded to the provider;
//  - the badge COUNT. The catalogue answers with the outdated skills themselves;
//    the row draws a number, and `> 0` is what decides whether it draws at all;
//  - whether the workspace has a manifest, which is the one fact behind two
//    different rows: "Create a Mod" reads as "Edit Project", and Publish Mod
//    appears at all;
//  - the `run` guard. A row names its own command, so the host executes a string
//    that came out of a document — an empty one is dropped rather than run;
//  - the BOOT REPLAY. `ready` is answered with all three pushes, which is the
//    only reason the status has to be readable on demand here (card 29).
//
// What stays in the shell (`src/nav/navView.ts`) is the view, the rendered
// document with its logo, the three subscriptions and their teardown, the
// manifest file watcher and the `dcs-studio.toml` stat.

/** Something only the editor can do, described rather than done. */
export type NavEffect =
  /** Run the extension command a nav row names. */
  { kind: "runCommand"; command: string };

/**
 * The message shapes the nav webview sends the host — the declared contract, not
 * a local restatement of it.
 */
export type NavInbound = NavWebviewMessage;

export interface NavPresenterDeps {
  /**
   * Both bridges' status as it is NOW.
   *
   * The other two facts below are already pull-shaped, but the status only ever
   * arrived by subscription — which is exactly why a `ready` handshake could not
   * answer with it before. Read on demand rather than remembered here: the router
   * holds the authoritative pair, and a copy in the presenter would be a second
   * one to keep in step.
   */
  status: () => DualBridgeStatus;
  /** Installed skills with a newer bundled version, for the badge. */
  updatesAvailable: () => Promise<readonly SkillInfo[]>;
  /** Whether the workspace has a `dcs-studio.toml`. */
  manifestExists: () => Promise<boolean>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/nav.js` has no case for cannot be sent from here without the
   * contract being updated first.
   *
   * The dead-view guard stays on the shell's side of this: the sidebar's three
   * signals outlive the view they draw, so a push after disposal must be a
   * no-op rather than a throw, and the shell holds the only reference that can
   * tell.
   */
  post: (msg: NavHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: NavEffect) => void;
}

export class NavPresenter {
  constructor(private readonly deps: NavPresenterDeps) {}

  /**
   * The footer, from the two-bridge status.
   *
   * The sidebar deliberately says less than the console does. It has one dot and
   * one clock for two bridges, so "connected" is either of them being up — a
   * sidebar that went grey because the mission bridge is down while the GUI
   * bridge is answering would be lying about a session the user can use.
   * `dcsTime > 0` is then read by the webview as "a mission is running".
   */
  pushStatus(status: DualBridgeStatus): void {
    this.deps.post({
      type: "status",
      status: {
        connected: status.gui.connected || status.mission.connected,
        dcsTime: displayTime(status),
      },
    });
  }

  /**
   * The Agent Skills row's badge.
   *
   * A count, not the list: the row has room for a number and the webview hides
   * the badge entirely at zero, so what crosses is the only part it can draw.
   */
  async pushSkills(): Promise<void> {
    this.deps.post({ type: "skills", updates: (await this.deps.updatesAvailable()).length });
  }

  /**
   * Whether the workspace is already a mod project.
   *
   * One boolean behind two rows: with a manifest, "Create a Mod" is really
   * editing one, and Publish Mod stops being a button that could only fail.
   */
  async pushManifest(): Promise<void> {
    this.deps.post({ type: "manifest", hasManifest: await this.deps.manifestExists() });
  }

  /**
   * The sidebar's opening state, answering its boot handshake.
   *
   * All three pushes are also made unprompted when the view resolves; this is the
   * SECOND chance, and the reason there is one is that both of those pushes are
   * async and can land before `media/nav.js` has attached its listener. A lost
   * push leaves the sidebar complete but stale, and the stale state that matters
   * is Publish Mod staying hidden in a workspace that is already a mod project —
   * so the user's route to publishing is absent from the sidebar until a
   * workspace-folder change or the file watcher sees `dcs-studio.toml` appear,
   * neither of which happens when an existing project is simply opened (card 29).
   *
   * Both pushes are idempotent, so answering is cheap and safe however many times
   * the editor re-resolves the view.
   */
  async ready(): Promise<void> {
    this.pushStatus(this.deps.status());
    await this.pushSkills();
    await this.pushManifest();
  }

  async handle(msg: NavInbound): Promise<void> {
    switch (msg.type) {
      case "run":
        // The command id comes out of the document, so it may be absent from a
        // stale or crafted post. Running "" would raise an editor error dialog
        // for something no user asked for.
        if (msg.command) this.deps.effect({ kind: "runCommand", command: msg.command });
        break;
      case "ready":
        await this.ready();
        break;
    }
  }
}
