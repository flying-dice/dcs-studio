// Port: GitHub CLI operations used by publish, expressed as intents (no raw
// command strings). The adapter drives the `gh` CLI.

import type { GhFacts } from "../domain/publishChecks";

/** Outcome of a repo-create attempt (idempotent — reuse when it already exists). */
export interface GhRepoCreateResult {
  created: boolean;
  alreadyExists: boolean;
}

export interface GhRepoCreateOptions {
  name: string;
  description?: string;
  visibility?: "public" | "private";
  /** Local repo to create from and push. */
  source: string;
  /** Remote name to wire up (e.g. `origin`). */
  remote?: string;
  /** Whether to push after creating. */
  push?: boolean;
}

export interface GhReleaseCreateOptions {
  repo: string;
  tag: string;
  title: string;
  notes: string;
  /** Absolute paths of assets to upload. */
  assets: string[];
}

export interface GhReleaseEditOptions {
  repo: string;
  tag: string;
  title: string;
  notes: string;
}

export interface GhPort {
  /** gh CLI presence + auth, gathered in ONE probe pass. A single method by
   *  design: separate installed/authed probes each re-ran `gh --version` and
   *  the network-bound `gh auth status`, doubling a cost measured at seconds
   *  on a cold machine. */
  facts(): Promise<GhFacts>;
  /** The signed-in GitHub login, or null. */
  login(): Promise<string | null>;
  /** Create (or reuse) a GitHub repo, optionally pushing. */
  repoCreate(opts: GhRepoCreateOptions): Promise<GhRepoCreateResult>;
  /** Add a discovery topic to a repo; false when the attempt failed. */
  repoTopicAdd(repo: string, topic: string): Promise<boolean>;
  /** Whether a release for `tag` already exists. */
  releaseView(repo: string, tag: string): Promise<boolean>;
  /** Delete a release and its tag (idempotent). */
  releaseDelete(repo: string, tag: string): Promise<void>;
  /** Create a release for `tag` and upload its assets. */
  releaseCreate(opts: GhReleaseCreateOptions): Promise<void>;
  /** Upload assets onto an existing release, overwriting same-named ones. */
  releaseUpload(repo: string, tag: string, assets: string[]): Promise<void>;
  /** Update an existing release's title and notes. */
  releaseEdit(opts: GhReleaseEditOptions): Promise<void>;
  /** The asset file names currently attached to a release. */
  releaseAssetNames(repo: string, tag: string): Promise<string[]>;
  /** Detach one asset from a release; false when the attempt failed. */
  releaseAssetDelete(repo: string, tag: string, name: string): Promise<boolean>;
}
