import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Windows refuses `CreateSymbolicLink` with EPERM unless the account holds
// SeCreateSymbolicLinkPrivilege — granted by Developer Mode, by an elevated
// session, or by local policy. Plain user sessions on ordinary dev boxes hold
// none of those, so any test that creates a real symlink fails there for a
// reason that has nothing to do with the code under test.
//
// Two things follow, and this module provides both:
//
//  - `canSymlink()` says whether this host can do it at all, so the one test
//    that is genuinely *about* symlink creation can skip rather than fail;
//  - `linkForSetup()` gives every other test a link it can have without the
//    privilege — a junction for directories, a hard link for files — because
//    those tests only needed *a link on disk* to set the scene.
//
// CI is deliberately excluded from the escape hatch: windows-latest runs as an
// administrator and does hold the privilege, so a missing privilege there means
// the runner changed underneath us, and silently skipping would hide it.

let cached: boolean | undefined;

/**
 * Whether this host can create a real symbolic link, probed once by doing it.
 *
 * Memoised rather than computed at import time on purpose: the tests that ask
 * mock `node:fs`, and a module-level probe would run inside that mock before
 * the test file's own state is initialised.
 *
 * @throws if the privilege is missing under CI, where it must never be.
 */
export function canSymlink(): boolean {
  if (cached === undefined) {
    cached = probe();
    if (!cached && process.env.CI) {
      throw new Error(
        "Cannot create symbolic links on this CI host. windows-latest runs elevated " +
          "and does hold SeCreateSymbolicLinkPrivilege, so this means the runner image " +
          "or the job's user changed — symlink tests must not silently skip in CI.",
      );
    }
  }
  return cached;
}

function probe(): boolean {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dcs-symlink-probe-"));
  try {
    nodeFs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The reason to put on a skip, so the reader knows how to make the test run. */
export const symlinkSkipReason =
  "needs SeCreateSymbolicLinkPrivilege — enable Windows Developer Mode " +
  "(Settings > System > For developers) or run the suite elevated";

/**
 * Create a link at `link` pointing at `target`, by whatever mechanism this host
 * permits — for tests that need a link to exist, not a symlink specifically.
 *
 * On Windows a directory becomes a junction and a file becomes a hard link,
 * neither of which needs any privilege. Everywhere else, and on a Windows host
 * that does hold the privilege for directories anyway, this is a symlink.
 *
 * A junction may point at a path that does not exist, so the "broken link"
 * cases keep working. A hard link may not — it is a second name for an existing
 * inode — so a broken *file* link is rejected loudly rather than half-made.
 */
export function linkForSetup(target: string, link: string, kind: "dir" | "file"): void {
  if (process.platform !== "win32") {
    nodeFs.symlinkSync(target, link, kind);
    return;
  }
  if (kind === "dir") {
    // Junctions need no privilege and, unlike hard links, tolerate a missing
    // target — which is exactly what the broken-link cases set up.
    nodeFs.symlinkSync(target, link, "junction");
    return;
  }
  if (!nodeFs.existsSync(target)) {
    throw new Error(
      `linkForSetup cannot make a broken file link on Windows: ${target} does not exist. ` +
        "A hard link is a second name for an existing file. Use a directory " +
        "(junction) for a deliberately broken link, or gate the test on canSymlink().",
    );
  }
  nodeFs.linkSync(target, link);
}
