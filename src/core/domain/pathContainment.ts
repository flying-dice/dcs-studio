// The containment predicate every untrusted manifest path is measured against.
//
// A `dcs-studio.toml` arrives inside a stranger's GitHub release, so every path
// it declares — a `[[symlink]]` dest and source, an `[[entrypoint]]` exe and
// cwd, a `[[mission_script]]` path — is hostile input that gets joined onto a
// root the user can write to. Without a containment check, `..` survives the
// join and the mod picks the destination: an arbitrary-file-write primitive
// dressed up as an install.
//
// The rules are the bridge's, deliberately. `bridge-core`'s path_guard.rs
// hardened `lfs.writedir()` writes against exactly these shapes, and the two
// halves of the product must not disagree about what a safe relative path is —
// so `staysUnder` below is a line-for-line mirror of `stays_under` there. The
// webview carries a third copy (`media/manifest-core.js`, which the browser
// loads as a UMD global and cannot import TypeScript); the unit layer asserts
// that copy against this one so the pair cannot drift.
//
// TODO: clean-code - 0.55 - DRY (#46): that anti-drift check covers two of the three
// copies. The Rust one is held to a hand-retyped table in its own tests, so a
// case added here and in the webview — but not retyped there — leaves the
// bridge's guard quietly weaker than the extension's, in a security predicate.
// One shared JSON case table, read by all three test suites, closes it.
//
// Windows semantics on every host, for the same reason the Rust guard spells
// its rules out by hand: DCS is Windows-only, but Node's `path` — like Rust's
// `Path` — parses `C:\Windows` as a single ordinary component off-Windows, so a
// guard delegating to the platform silently accepts drive-prefixed and
// backslash-climbing input on Linux CI. Everything here is string arithmetic
// only: NO I/O, NO filesystem probing, the same verdict everywhere.

/** The root tokens a manifest `dest` may name; mirrors media/manifest-core.js. */
export const ROOT_TOKENS = ["{SavedGames}", "{GameInstall}"];

/**
 * True when `path` is a relative path that stays under whatever root it is
 * joined onto.
 *
 * Rejects, with Windows semantics on every host:
 * - empty input, and input that is only separators or dots;
 * - absolute paths (`/x`, `\x`) and UNC paths (`\\server\share`);
 * - any drive or stream prefix — a `:` anywhere, which also blocks NTFS
 *   alternate-data-stream writes such as `notes.txt:hidden`;
 * - any `..` component, on either separator;
 * - empty components from doubled or trailing separators (`a//b`, `a/`).
 *
 * A bare `.` component is allowed and normalises away (`./a` == `a`).
 */
export function staysUnder(path: string): boolean {
  if (!path) return false;
  // A colon can only be a drive prefix or an alternate data stream here;
  // neither is a legitimate relative path under a root.
  if (path.includes(":")) return false;
  // Leading separator = rooted, on either slash. Also catches UNC's `\\`.
  if (path.startsWith("/") || path.startsWith("\\")) return false;

  let normal = 0;
  for (const component of path.split(/[/\\]/)) {
    // An empty component is a doubled or trailing separator; `..` climbs out.
    // Both are refused rather than normalised, so the guard never has to reason
    // about what a path means after rewriting it.
    if (component === "" || component === "..") return false;
    // `.` is a no-op segment, not a normal one — `./a` is still `a`.
    if (component !== ".") normal++;
  }
  // `.` or `./.` names the root itself, not a path under it.
  return normal > 0;
}

/**
 * The part of a manifest `dest` that actually gets joined onto a DCS root: the
 * leading `{SavedGames}`/`{GameInstall}` token and one root-relative separator
 * removed. Mirrors `splitDest` in media/manifest-core.js, which treats an
 * unrecognised prefix as `{SavedGames}`-relative — so `/Scripts/Hooks` and
 * `Scripts/Hooks` name the same place and both are measured as `Scripts/Hooks`.
 */
export function destRelative(dest: string): string {
  for (const token of ROOT_TOKENS) {
    if (dest.startsWith(token)) return dest.slice(token.length).replace(/^\//, "");
  }
  return dest.replace(/^\//, "");
}

/** True when a manifest `dest` stays under the DCS root it names. */
export function destStaysUnder(dest: string): boolean {
  return staysUnder(destRelative(dest));
}
