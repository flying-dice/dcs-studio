import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { BridgeFs } from "../../../src/bridge/deploy";

// A real filesystem for the deploy/launch specs, rooted in a temp directory.
//
// Every DCS path the extension builds is a Windows path — `D:\Saved
// Games\DCS\Mods\tech\DcsStudio\bin\dcs_studio_gui.dll` — because DCS only runs
// on Windows and core/domain/bridgeDeploy builds them with `path.win32`. Handing
// one of those to a POSIX `fs` would create a single file whose *name* contains
// backslashes, relative to the process's working directory, so nothing about the
// layout would actually be exercised (and the repo would fill with junk).
//
// This maps a Windows path onto a real directory tree under `root` and then does
// real filesystem work: real mkdir, real copies, real deletes. What is under
// test — that the DLLs and the hook end up in the right place, that missing
// directories get created, that an eject really removes them — is checked
// against files that genuinely exist.

/** `D:\Saved Games\DCS\x.dll` under `root` → `<root>/D/Saved Games/DCS/x.dll`. */
export function realPath(root: string, winPath: string): string {
  const parts = winPath.replace(/:/g, "").split(/[\\/]/).filter(Boolean);
  return nodePath.join(root, ...parts);
}

/** Overrides for the failure modes that need a running DCS to happen for real. */
export type BridgeFsOverrides = Partial<BridgeFs>;

export interface MappedBridgeFs extends BridgeFs {
  /** The real location of a Windows path, for seeding and assertions. */
  real(winPath: string): string;
  /** Seed a file (creating its directories) at a Windows path. */
  seed(winPath: string, contents: string): void;
  /** Read a Windows path back, or undefined if it isn't there. */
  read(winPath: string): string | undefined;
  exists(winPath: string): boolean;
}

export function mappedBridgeFs(root: string, over: BridgeFsOverrides = {}): MappedBridgeFs {
  const real = (winPath: string) => realPath(root, winPath);
  return {
    real,
    seed(winPath, contents) {
      const p = real(winPath);
      fs.mkdirSync(nodePath.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents);
    },
    read(winPath) {
      const p = real(winPath);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
    },
    exists(winPath) {
      return fs.existsSync(real(winPath));
    },
    existsSync: (p) => fs.existsSync(real(p)),
    mkdir: (p, opts) => fs.promises.mkdir(real(p), opts),
    copyFile: (src, dest) => fs.promises.copyFile(real(src), real(dest)),
    rm: (p, opts) => fs.promises.rm(real(p), opts),
    ...over,
  };
}

/** An error as node reports a file held open by another process (a running DCS). */
export function lockedError(): NodeJS.ErrnoException {
  const e = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
  e.code = "EBUSY";
  return e;
}
