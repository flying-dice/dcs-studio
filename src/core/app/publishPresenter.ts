import { errorText } from "../domain/errorText";
import { type Check, firstBlocker } from "../domain/publishChecks";
import { parseRepoRemote, type RepoRef } from "../domain/repoRemote";
import type { ManifestModel } from "../domain/types";
import type { ReleaseOpts, ReleaseResult, ShareOpts, ShareResult } from "./publishService";
import type {
  PublishBusyScope,
  PublishHostMessage,
  PublishWebviewMessage,
} from "./webviewContract";

// The Publish panel's decision logic, lifted out of the VS Code panel.
//
// This is the flow with the least margin for error in the product: a share
// creates a real GitHub repository and pushes to it, and a release packages
// assets and uploads them onto a tag. `PublishService` already owned the
// irreversible ordering rules, and `core/domain/publishChecks.ts` already owned
// the pass/warn/fail policy — but the decisions BETWEEN them were welded to the
// panel, and they are the ones that decide whether either runs at all:
//
//  - "no workspace folder" as a whole different view, and a folderless window
//    ignoring every action rather than acting on an undefined root;
//  - the init payload: which manifest fields seed the form and what each falls
//    back to when the manifest is missing or bare (`version` falls back to
//    `0.1.0`, not to an empty box);
//  - repo detection — an `origin` URL that is not a recognisable GitHub remote
//    is "not shared yet", not an error;
//  - **re-running preflight at the moment an action is taken** rather than
//    trusting the disabled state the webview derived from the last run, and
//    logging the blocker that refused it;
//  - the busy bracket: `busy` on, always `busy` off, and a failure rendered as a
//    log line rather than thrown away — a stuck latch leaves a dead button.
//
// None of it knows about VS Code. What stays in the shell (`src/publish/
// publishPanel.ts`) is the panel, the workspace root, the fs-and-spawn preflight
// gathering, and the one effect below.

/** Something only the editor can do, described rather than done. */
export type PublishEffect = { kind: "openExternal"; url: string };

/**
 * The message shapes the publish webview sends the host — the declared contract,
 * not a local restatement of it. Named here as well so the panel keeps importing
 * its boundary type from the module it talks to.
 */
export type PublishInbound = PublishWebviewMessage;

export interface PublishPresenterDeps {
  /**
   * The workspace folder being published, or `null` when no folder is open.
   *
   * A value rather than a getter, deliberately: the panel resolves the folder
   * once when it opens and every later decision uses that same root, so a
   * re-read here would be a second, different rule.
   */
  root: string | null;
  /**
   * Gather the readiness checks for `root`. Welded to the outside world on the
   * other side (it stats every `[[bundle]]` path and probes for 7z/git/gh), so
   * it arrives as a dep; the pass/warn/fail policy inside it is already pure.
   */
  preflight: (root: string) => Promise<Check[]>;
  /** The parsed manifest at `root`, or `null` when it is absent or unreadable. */
  readManifest: (root: string) => ManifestModel | null;
  /** `root`'s `origin` URL, or `null` when it has no such remote. */
  remoteUrl: (root: string) => Promise<string | null>;
  /** Create/reuse the GitHub repo and push. Streams progress lines through `log`. */
  share: (root: string, opts: ShareOpts, log: (line: string) => void) => Promise<ShareResult>;
  /** Package the payload and publish the release. Streams progress lines. */
  cutRelease: (
    root: string,
    opts: ReleaseOpts,
    log: (line: string) => void,
  ) => Promise<ReleaseResult>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/publish.js` has no case for cannot be sent from here without
   * the contract being updated first.
   */
  post: (msg: PublishHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: PublishEffect) => void;
}

export class PublishPresenter {
  constructor(private readonly deps: PublishPresenterDeps) {}

  /** The panel's opening state: the no-folder view, or a full preflight render. */
  async refresh(): Promise<void> {
    if (this.deps.root === null) {
      this.deps.post({ type: "nofolder" });
      return;
    }
    await this.pushInit(this.deps.root);
  }

  /** Run preflight, re-render the panel from it, and hand back the checks. */
  private async pushInit(root: string): Promise<Check[]> {
    const checks = await this.deps.preflight(root);
    const m = this.deps.readManifest(root);
    const repo = await this.detectRepo(root);
    this.deps.post({
      type: "init",
      checks,
      repo,
      defaults: {
        name: m?.project.name || "",
        description: m?.project.description || "",
        // A version box the user has to fill in before anything works is worse
        // than a starting point they can edit.
        version: m?.project.version || "0.1.0",
      },
    });
    return checks;
  }

  /** The GitHub repo `origin` points at, or `null` — including when the remote
   * exists but is not a GitHub URL this can name, which is "not shared yet"
   * rather than a failure. */
  private async detectRepo(root: string): Promise<RepoRef | null> {
    const url = await this.deps.remoteUrl(root);
    return url ? parseRepoRemote(url) : null;
  }

  /**
   * Re-run preflight at the moment an action is taken, rather than trusting the
   * disabled state the webview derived from the last run. A manifest deleted or
   * a `[[bundle]]` path removed since then would otherwise sail through to a
   * real repository, because nothing else validates on the way in. The re-run
   * re-renders too, so a refusal leaves the reason on screen.
   */
  private async blocked(root: string): Promise<boolean> {
    const blocker = firstBlocker(await this.pushInit(root));
    if (!blocker) return false;
    this.log(`✖ ${blocker.label}: ${blocker.detail}`);
    return true;
  }

  async handle(msg: PublishInbound): Promise<void> {
    // Every action below is about `root`; without one there is nothing to
    // publish, so a message arriving anyway is ignored rather than guessed at.
    if (this.deps.root === null) return;
    const root = this.deps.root;
    switch (msg.type) {
      case "refresh":
        await this.refresh();
        break;
      case "share":
        await this.guard("share", async () => {
          if (await this.blocked(root)) return;
          // Cast, not a guard: the union declares what may ARRIVE (a stale or
          // crafted post may carry no `opts` at all), and the service's own
          // argument checks are what decide — `share` refuses an empty name at
          // the CLI, as it must whatever the panel sent.
          const result = await this.deps.share(root, msg.opts as ShareOpts, (l) => this.log(l));
          this.deps.post({ type: "shareDone", result });
        });
        break;
      case "release":
        await this.guard("release", async () => {
          if (await this.blocked(root)) return;
          const result = await this.deps.cutRelease(root, msg.opts as ReleaseOpts, (l) =>
            this.log(l),
          );
          this.deps.post({ type: "releaseDone", result });
        });
        break;
      case "openExternal":
        if (msg.url) this.deps.effect({ kind: "openExternal", url: msg.url });
        break;
    }
  }

  /**
   * Bracket one long action with the webview's busy latch. The `finally` is the
   * point: a failure that skipped it would leave the button disabled and
   * relabelled "Sharing…" with no way to retry, and publishing is exactly the
   * flow where a user needs to try again.
   */
  private async guard(scope: PublishBusyScope, fn: () => Promise<void>): Promise<void> {
    this.deps.post({ type: "busy", scope, busy: true });
    try {
      await fn();
    } catch (e) {
      this.log(`✖ ${errorText(e)}`);
    } finally {
      this.deps.post({ type: "busy", scope, busy: false });
    }
  }

  private log(line: string): void {
    this.deps.post({ type: "log", line });
  }
}
