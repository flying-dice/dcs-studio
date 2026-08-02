import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

// One place that owns scratch directories for the tests that need a real
// filesystem — and, more importantly, one place that owns the *order* in which
// they are torn down.
//
// Every such test used to hand-roll `mkdtempSync` in a `beforeEach` and
// `rmSync` in an `afterEach`. That is fine until a test injects a `node:fs`
// fault (see `linkerStrategies.test.ts`, which makes `symlinkSync`/`rmSync`
// throw): the cleanup then runs through the same fault it installed, and the
// suite fails in teardown for a reason that has nothing to do with the test.
// The fix has to be remembered in every file that does it — so it is here
// instead: register the unwind with `beforeCleanup()` and this helper runs it
// immediately before the removal, every time, whatever the file forgets.
//
// `test/support/linkCapability.ts` stays separate: that answers "may this host
// create a symlink at all", which is a capability question, not a scratch-space
// one.

/** Files and directories built under one directory. */
export interface TmpTree {
  /** Absolute path of this tree's own directory. */
  readonly path: string;
  /** Absolute path of `parts` resolved inside this tree. */
  join(...parts: string[]): string;
  /** Writes `rel` (creating parents) and returns its absolute path. */
  file(rel: string, content?: string): string;
  /** Creates `rel`, plus any `children` inside it, and returns its path. */
  dir(rel: string, children?: Record<string, string>): string;
  /** A sub-tree rooted at `rel`, created now. */
  tree(rel: string): TmpTree;
}

/** A scratch directory, removed for you when its scope ends. */
export interface TmpRoot extends TmpTree {
  /**
   * A further scratch directory, tracked for the same cleanup, which also
   * becomes this root's `path`. For the tests that need more than one.
   */
  make(): string;
  /**
   * Runs immediately before the tracked directories are removed — where a test
   * clears any `node:fs` faults it injected, so teardown does not trip them.
   */
  beforeCleanup(fn: () => void): void;
}

function treeAt(at: () => string): TmpTree {
  const join = (...parts: string[]) => nodePath.join(at(), ...parts);
  const tree: TmpTree = {
    get path() {
      return at();
    },
    join,
    file(rel, content = "payload") {
      const p = join(rel);
      nodeFs.mkdirSync(nodePath.dirname(p), { recursive: true });
      nodeFs.writeFileSync(p, content);
      return p;
    },
    dir(rel, children) {
      const p = join(rel);
      nodeFs.mkdirSync(p, { recursive: true });
      for (const [name, content] of Object.entries(children ?? {})) {
        nodeFs.writeFileSync(nodePath.join(p, name), content);
      }
      return p;
    },
    tree(rel) {
      const p = join(rel);
      nodeFs.mkdirSync(p, { recursive: true });
      return treeAt(() => p);
    },
  };
  return tree;
}

/**
 * A temp directory under `os.tmpdir()`, named with `prefix` so a leak is
 * traceable to the suite that left it.
 *
 * Scope `"test"` (the default) makes a fresh directory for every test and
 * removes it afterwards; `"suite"` makes one directory for the whole file,
 * removed after the last test — for state a suite deliberately shares.
 */
export function tmpRoot(prefix: string, options?: { scope?: "test" | "suite" }): TmpRoot {
  const tracked: string[] = [];
  const unwinds: (() => void)[] = [];
  let current = "";

  const make = () => {
    current = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
    tracked.push(current);
    return current;
  };

  const cleanup = () => {
    // The faults first, or the removal below runs straight into them.
    for (const unwind of unwinds) unwind();
    for (const dir of tracked) nodeFs.rmSync(dir, { recursive: true, force: true });
    tracked.length = 0;
  };

  if (options?.scope === "suite") {
    make();
    afterAll(cleanup);
  } else {
    // Registered before anything the calling file registers, so with vitest's
    // stacked hook order this cleanup runs *after* the file's own `afterEach` —
    // whose assertions therefore still see the directory.
    beforeEach(make);
    afterEach(cleanup);
  }

  return {
    ...treeAt(() => current),
    get path() {
      return current;
    },
    make,
    beforeCleanup(fn) {
      unwinds.push(fn);
    },
  };
}
