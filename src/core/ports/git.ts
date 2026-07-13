// Port: local git operations used by publish, expressed as intents (no raw
// command strings). The adapter drives the `git` CLI.

export interface GitPort {
  /** Whether git is available on the system. */
  isInstalled(): Promise<boolean>;
  /** Whether `root` is inside a git work tree. */
  isRepo(root: string): Promise<boolean>;
  /** Initialise a repo at `root` and set its default branch to `main`. */
  init(root: string): Promise<void>;
  /** Stage all changes under `root`. */
  addAll(root: string): Promise<void>;
  /** Whether the work tree has staged/unstaged changes to commit. */
  hasChanges(root: string): Promise<boolean>;
  /** Commit staged changes with `message` (using the extension's identity). */
  commit(root: string, message: string): Promise<void>;
  /** The URL of `remote` (default `origin`), or null when unset. */
  getRemoteUrl(root: string, remote?: string): Promise<string | null>;
  /** Point `remote` at `url` (adding it if absent). */
  setRemote(root: string, remote: string, url: string): Promise<void>;
  /** Push `ref` to `remote`, setting upstream. */
  push(root: string, remote: string, ref: string): Promise<void>;
}
