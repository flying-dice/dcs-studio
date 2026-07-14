import { spawn } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
} from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  chooseLinkStrategy,
  classifyExistingDest,
  sameVolume,
} from "../../core/domain/linkStrategy";
import type {
  DisableResult,
  InstalledLink,
  LinkDefinition,
  LinkResult,
  ResolvedLink,
} from "../../core/domain/types";
import type { LinkerPort } from "../../core/ports/linker";

// Node adapter for `LinkerPort`, ported from dcs-dropzone/packages/linker (the
// proven impl): create/remove the links between unpacked assets in the data dir
// and their declared destinations. The pure decisions (dir → junction,
// same-volume file → hard link, cross-volume file → symlink retried elevated via
// a UAC prompt on EPERM; merge-into-existing-real-directory rule) live in
// core/domain/linkStrategy.ts — this adapter probes the facts, performs the
// syscalls, and maps failures to messages. A directory destination that already
// exists as a real directory (e.g. Saved Games\Scripts\Hooks) is merged into:
// each child is linked individually, so shared DCS folders never block an enable
// and a disable removes only our links. enable() rolls all links back if any one
// fails; disable() removes the link entries, never their targets.

function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Create a symlink elevated (UAC) — the cross-volume file fallback. */
function createSymlinkElevated(
  link: string,
  target: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const inner = `$ErrorActionPreference='Stop'; New-Item -ItemType SymbolicLink -Path ${psSingleQuote(
    link,
  )} -Target ${psSingleQuote(target)} -Force | Out-Null`;
  const launcher = `Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-Command", ${psSingleQuote(
    inner,
  )});`;
  return new Promise((resolve) => {
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launcher],
      {
        windowsHide: true,
      },
    );
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, message: e.message }));
    p.on("exit", (c) =>
      c === 0 ? resolve({ ok: true }) : resolve({ ok: false, message: err.trim() || `exit ${c}` }),
    );
  });
}

/**
 * Whether an existing destination is a link we created for this exact source:
 * a junction/symlink whose real path resolves to `src`, or a hard link sharing
 * `src`'s inode. Used to make a re-enable idempotent instead of a conflict.
 */
function destPointsAtSrc(dest: string, src: string, destStat: Stats): boolean {
  try {
    if (destStat.isSymbolicLink()) {
      return resolve(realpathSync(dest)) === resolve(realpathSync(src));
    }
    const d = statSync(dest);
    const s = statSync(src);
    return d.ino !== 0 && d.ino === s.ino && d.dev === s.dev;
  } catch {
    return false;
  }
}

/** Create one link, choosing junction / hard link / symlink by platform + shape. */
export async function mklink(
  link: string,
  target: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (existsSync(link)) return { ok: false, message: `Link path already exists: ${link}` };
  const targetStat = statSync(target);
  const strategy = chooseLinkStrategy({
    isWindows: platform() === "win32",
    isDir: targetStat.isDirectory(),
    sameVolume: sameVolume(link, target),
  });

  switch (strategy) {
    case "symlink-dir":
    case "symlink-file":
      try {
        symlinkSync(target, link, strategy === "symlink-dir" ? "dir" : "file");
        return { ok: true };
      } catch (e) {
        return { ok: false, message: `Failed to create symbolic link: ${e}` };
      }
    case "junction":
      try {
        symlinkSync(target, link, "junction");
        return { ok: true };
      } catch (e) {
        return { ok: false, message: `Failed to create junction: ${e}` };
      }
    case "hardlink":
      try {
        linkSync(target, link);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: `Failed to create hard link: ${e}` };
      }
    case "symlink-cross":
      // Cross-volume file: symlink, elevating on EPERM.
      try {
        symlinkSync(target, link, "file");
        return { ok: true };
      } catch (e) {
        const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
        if (code === "EPERM") {
          const elevated = await createSymlinkElevated(link, target);
          return elevated.ok ? { ok: true } : { ok: false, message: elevated.message };
        }
        return { ok: false, message: `Failed to create symbolic link: ${e}` };
      }
  }
}

export class Linker implements LinkerPort {
  /** Create all links; roll back everything on the first failure. */
  async enable(links: LinkDefinition[]): Promise<LinkResult> {
    const created: ResolvedLink[] = [];
    for (const link of links) {
      const r = await this.createLink(link);
      if (!r.ok) {
        this.rollback(created);
        return { ok: false, message: r.message };
      }
      created.push(...r.links);
    }
    return { ok: true, created };
  }

  /** Remove link entries; each is attempted regardless of others' failures. */
  disable(links: InstalledLink[]): DisableResult {
    const removed: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const link of links) {
      try {
        const stat = lstatSync(link.installedPath, { throwIfNoEntry: false });
        if (!stat) {
          removed.push(link.id); // already absent
          continue;
        }
        // rmSync on a junction/symlink removes the reparse point, not its target.
        rmSync(link.installedPath, { force: true, recursive: true });
        removed.push(link.id);
      } catch (e) {
        failed.push({ id: link.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { removed, failed };
  }

  private async createLink(
    link: LinkDefinition,
  ): Promise<{ ok: true; links: ResolvedLink[] } | { ok: false; message: string }> {
    const srcStat = lstatSync(link.src, { throwIfNoEntry: false });
    if (!srcStat) {
      return { ok: false, message: `Source path does not exist: ${link.src}` };
    }
    try {
      const parent = dirname(link.dest);
      if (!lstatSync(parent, { throwIfNoEntry: false })) mkdirSync(parent, { recursive: true });
    } catch (e) {
      return { ok: false, message: `Failed to create parent directory: ${e}` };
    }
    const destStat = lstatSync(link.dest, { throwIfNoEntry: false });
    if (destStat) {
      // A real directory (not a junction/symlink — lstat reports those as
      // symbolic links) that already exists, like Scripts\Hooks, is merged
      // into. A link we already created for this source (idempotent re-enable)
      // is adopted. Anything else is a genuine foreign-file conflict.
      const disposition = classifyExistingDest({
        srcIsDir: srcStat.isDirectory(),
        destIsDir: destStat.isDirectory(),
        destIsSymlink: destStat.isSymbolicLink(),
        ownedByUs: destPointsAtSrc(link.dest, link.src, destStat),
      });
      if (disposition === "merge") {
        const created: ResolvedLink[] = [];
        for (const entry of readdirSync(link.src)) {
          const child = await this.createLink({
            id: `${link.id}/${entry}`,
            src: join(link.src, entry),
            dest: join(link.dest, entry),
          });
          if (!child.ok) {
            this.rollback(created);
            return child;
          }
          created.push(...child.links);
        }
        return { ok: true, links: created };
      }
      if (disposition === "enter") {
        // File rule aimed at an existing real directory: link the file INTO
        // it. Recursing with the child path lets adopt (idempotent re-enable)
        // and conflict (a foreign file of the same name, reported by its exact
        // path) apply at the file level; the ledger records the child dest so
        // disable removes only that link.
        return this.createLink({
          id: link.id,
          src: link.src,
          dest: join(link.dest, basename(link.src)),
        });
      }
      if (disposition === "adopt") {
        // Re-enable with our link still present: no filesystem change, just
        // re-track it so the ledger and disable stay correct.
        return { ok: true, links: [{ id: link.id, src: link.src, dest: link.dest }] };
      }
      return { ok: false, message: `Destination path already exists: ${link.dest}` };
    }
    const r = await mklink(link.dest, link.src);
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, links: [{ id: link.id, src: link.src, dest: link.dest }] };
  }

  private rollback(created: ResolvedLink[]): void {
    for (const link of created) {
      try {
        if (lstatSync(link.dest, { throwIfNoEntry: false }))
          rmSync(link.dest, { force: true, recursive: true });
      } catch {
        /* best-effort */
      }
    }
  }
}
