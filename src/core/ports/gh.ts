// Port: GitHub CLI operations used by publish, expressed as intents (no raw
// command strings). The adapter drives the `gh` CLI.

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

export interface GhPort {
  /** Whether the gh CLI is available. */
  isInstalled(): Promise<boolean>;
  /** Whether gh is signed in. */
  isAuthed(): Promise<boolean>;
  /** The signed-in GitHub login, or null. */
  login(): Promise<string | null>;
  /** Create (or reuse) a GitHub repo, optionally pushing. */
  repoCreate(opts: GhRepoCreateOptions): Promise<GhRepoCreateResult>;
  /** Add a discovery topic to a repo. */
  repoTopicAdd(repo: string, topic: string): Promise<void>;
  /** Whether a release for `tag` already exists. */
  releaseView(repo: string, tag: string): Promise<boolean>;
  /** Delete a release and its tag (idempotent). */
  releaseDelete(repo: string, tag: string): Promise<void>;
  /** Create a release for `tag` and upload its assets. */
  releaseCreate(opts: GhReleaseCreateOptions): Promise<void>;
}
