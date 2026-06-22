// Publish flow store (model studio::publish, issue #12): share the open project
// to GitHub and cut a release. Both need a `public_repo`-scoped token — when the
// cached sign-in token is read-only they first run the device-flow escalation
// (githubAuthorizePublish), whose result arrives on the shared
// `github://authorized` event, then proceed. Mirrors packages.svelte.ts's run().

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  publishCan,
  publishShare,
  publishRelease,
  githubAuthorizePublish,
  githubLoginCancel,
  type GithubDeviceCode,
  type GithubSession,
  type RepoInfo,
  type ReleaseInfo,
} from "./api";
import { errorMessage } from "$lib/utils";
import { notifications } from "./notifications.svelte";
import {
  publishSharedNotification,
  publishReleasedNotification,
  publishFailedNotification,
} from "./notifications-classify";

class PublishStore {
  busy = $state(false);
  error = $state<string | null>(null);
  /** The device code shown while escalating the scope (null otherwise). */
  device = $state<GithubDeviceCode | null>(null);
  /** The shared repo after a successful share. */
  repo = $state<RepoInfo | null>(null);
  /** The published release after a successful release. */
  release = $state<ReleaseInfo | null>(null);

  #unlisteners: UnlistenFn[] = [];
  // Settles the in-flight escalation wait (set synchronously when armed).
  #settle: ((err: string | null) => void) | null = null;

  /** Ensure a publish-scoped token, escalating via the device flow if needed.
   * Listeners are armed and torn down in one try/finally (no leak on a failed
   * `githubAuthorizePublish`), and the scope is RE-verified afterwards because
   * `github://authorized` is shared with sign-in — a concurrent sign-in could
   * otherwise resolve us with a read-only token. */
  async #ensureScope(): Promise<void> {
    if (await publishCan()) return;

    const waited = new Promise<void>((resolve, reject) => {
      this.#settle = (err) => (err ? reject(new Error(err)) : resolve());
    });
    try {
      this.#unlisteners.push(
        await listen<GithubSession>("github://authorized", () => this.#settle?.(null)),
      );
      this.#unlisteners.push(
        await listen<{ message: string }>("github://error", (e) => this.#settle?.(e.payload.message)),
      );
      this.device = await githubAuthorizePublish();
      await waited;
    } finally {
      for (const u of this.#unlisteners) u();
      this.#unlisteners = [];
      this.#settle = null;
      this.device = null;
    }

    if (!(await publishCan())) {
      throw new Error("Publishing wasn't authorized — the public_repo scope wasn't granted.");
    }
  }

  /** Cancel an in-progress scope escalation: stop the backend poll loop and
   * unwedge the waiter (wired to the panel's Cancel while a code is showing). */
  cancel(): void {
    void githubLoginCancel().catch(() => {});
    this.#settle?.("Authorization cancelled.");
  }

  async #run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      try {
        await this.#ensureScope();
      } catch (error) {
        // An auth-flow abort or denial (the user cancelled, signed out, or
        // didn't grant the scope) is surfaced by the sign-in modal and the
        // panel's error line — it is not a publish *failure*, so it raises no
        // notification (model studio::notifications: only genuine errors).
        this.error = errorMessage(error);
        return;
      }
      await action();
    } catch (error) {
      this.error = errorMessage(error);
      notifications.add(publishFailedNotification(this.error));
    } finally {
      this.busy = false;
      this.device = null;
    }
  }

  /** Share the open project at `root` to GitHub. `asLibrary` marks it as a
   * dependency-only library (not installable from the Marketplace). */
  async share(root: string, asLibrary = false): Promise<void> {
    this.repo = null;
    await this.#run(async () => {
      this.repo = await publishShare(root, asLibrary);
      notifications.add(publishSharedNotification(this.repo.full_name));
    });
  }

  /** Publish a release `tag` for the shared project at `root`. */
  async publishReleaseTag(root: string, tag: string): Promise<void> {
    if (!tag.trim()) return;
    this.release = null;
    await this.#run(async () => {
      this.release = await publishRelease(root, tag.trim());
      notifications.add(publishReleasedNotification(this.release.tag));
    });
  }

  /** Drop publish state (and abandon any escalation) — called on sign-out. */
  reset(): void {
    this.#settle?.("Signed out.");
    this.error = null;
    this.device = null;
    this.repo = null;
    this.release = null;
  }
}

export const publish = new PublishStore();
