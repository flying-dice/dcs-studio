// Publish flow store (model studio::publish, issue #12): share the open project
// to GitHub and cut a release. Both actions need a `public_repo`-scoped token —
// when the cached sign-in token is read-only they first run the device-flow
// escalation (githubAuthorizePublish), whose result arrives on the shared
// `github://authorized` event, then proceed.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  publishCan,
  publishShare,
  publishRelease,
  githubAuthorizePublish,
  type GithubDeviceCode,
  type GithubSession,
  type RepoInfo,
  type ReleaseInfo,
} from "./api";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class PublishStore {
  busy = $state(false);
  error = $state<string | null>(null);
  /** The device code to show while escalating the scope (null otherwise). */
  device = $state<GithubDeviceCode | null>(null);
  /** The shared repo after a successful share. */
  repo = $state<RepoInfo | null>(null);
  /** The published release after a successful release. */
  release = $state<ReleaseInfo | null>(null);

  #unlisteners: UnlistenFn[] = [];
  #resolveAuth: (() => void) | null = null;
  #rejectAuth: ((e: Error) => void) | null = null;

  /** Ensure a publish-scoped token, escalating via the device flow if needed. */
  async #ensureScope(): Promise<void> {
    if (await publishCan()) return;
    // Attach listeners BEFORE showing the code so we never miss the result.
    this.#unlisteners.push(
      await listen<GithubSession>("github://authorized", () => this.#settleAuth(null)),
    );
    this.#unlisteners.push(
      await listen<{ message: string }>("github://error", (e) => this.#settleAuth(e.payload.message)),
    );
    const waited = new Promise<void>((resolve, reject) => {
      this.#resolveAuth = resolve;
      this.#rejectAuth = reject;
    });
    this.device = await githubAuthorizePublish();
    await waited;
  }

  #settleAuth(err: string | null): void {
    for (const u of this.#unlisteners) u();
    this.#unlisteners = [];
    this.device = null;
    if (err) this.#rejectAuth?.(new Error(err));
    else this.#resolveAuth?.();
    this.#resolveAuth = null;
    this.#rejectAuth = null;
  }

  /** Share the open project at `root` to GitHub. */
  async share(root: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.repo = null;
    try {
      await this.#ensureScope();
      this.repo = await publishShare(root);
    } catch (error) {
      this.error = message(error);
    } finally {
      this.busy = false;
      this.device = null;
    }
  }

  /** Publish a release `tag` for the shared project at `root`. */
  async publishReleaseTag(root: string, tag: string): Promise<void> {
    if (this.busy || !tag.trim()) return;
    this.busy = true;
    this.error = null;
    this.release = null;
    try {
      await this.#ensureScope();
      this.release = await publishRelease(root, tag.trim());
    } catch (error) {
      this.error = message(error);
    } finally {
      this.busy = false;
      this.device = null;
    }
  }
}

export const publish = new PublishStore();
