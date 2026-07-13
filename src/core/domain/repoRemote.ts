// Pure parse of a `git remote get-url` value into the GitHub {owner, name} pair.
// Handles the https and ssh forms, with or without a trailing `.git`, exactly as
// the publish panel's original inline regex did.

/** A GitHub repository reference resolved from a remote URL. */
export interface RepoRef {
  owner: string;
  name: string;
}

/**
 * Parse a `git remote get-url` value (`https://github.com/owner/name(.git)` or
 * `git@github.com:owner/name(.git)`) into `{ owner, name }`, or null when it is
 * not a recognisable GitHub remote.
 */
export function parseRepoRemote(remoteUrl: string): RepoRef | null {
  const m = remoteUrl.trim().match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  return m ? { owner: m[1], name: m[2] } : null;
}
