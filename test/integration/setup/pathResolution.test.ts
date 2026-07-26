import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const existing = new Set<string>();
vi.mock("fs", () => ({ existsSync: (p: string) => existing.has(p) }));
vi.mock("os", () => ({ homedir: () => "C:\\Users\\fallback" }));

import { installRoots, VsCodeInstallRoots } from "../../../src/adapters/vscode/installRoots";

// Where DCS Studio believes DCS lives. Every install, link and bridge injection
// is resolved from these three answers, so the precedence rules — settings
// override, then a probed default, then a fixed fallback — are the difference
// between a mod landing in the user's DCS folder and landing somewhere else.
//
// This is the adapter's half: reading settings, and asking the disk which of
// the candidates is really there. The candidate list and the data-dir default
// are pure string rules and are pinned in test/unit/setup/dcsDetect.test.ts.

const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let roots: VsCodeInstallRoots;

beforeEach(() => {
  resetVscode();
  existing.clear();
  process.env.USERPROFILE = "C:\\Users\\pilot";
  roots = new VsCodeInstallRoots();
});

describe("savedGames", () => {
  it("prefers the configured path, trimmed", () => {
    state.config["dcsStudio.savedGamesPath"] = "  D:\\Custom\\DCS  ";
    expect(roots.savedGames()).toBe("D:\\Custom\\DCS");
  });

  it("does not probe the disk when a path is configured", () => {
    // The user's answer wins even for a folder that does not exist yet: DCS
    // creates its write dir on first run, and falling back would send the
    // install somewhere the user never named.
    state.config["dcsStudio.savedGamesPath"] = "D:\\Custom\\DCS";
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    expect(roots.savedGames()).toBe("D:\\Custom\\DCS");
  });

  it("ignores a whitespace-only setting and falls back to detection", () => {
    state.config["dcsStudio.savedGamesPath"] = "   ";
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    expect(roots.savedGames()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("picks the stable DCS folder when both it and openbeta exist", () => {
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
    expect(roots.savedGames()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("takes the openbeta folder only when DCS is not there", () => {
    // The fallback is what made the installer and the manifest form agree on an
    // OpenBeta-only machine (issue #45) — but it must stay a fallback: taking
    // it while a plain DCS dir exists would move every install off the user's
    // main write dir.
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
    expect(roots.savedGames()).toBe("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");

    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    expect(roots.savedGames()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("returns the stable candidate when neither folder exists", () => {
    // Nothing detected: the caller shows a setup prompt, so this must still be
    // a sensible path rather than undefined.
    expect(roots.savedGames()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("uses the OS homedir when USERPROFILE is unset", () => {
    delete process.env.USERPROFILE;
    expect(roots.savedGames()).toBe("C:\\Users\\fallback\\Saved Games\\DCS");
  });
});

describe("gameInstall", () => {
  it("returns the configured install path, trimmed", () => {
    state.config["dcsStudio.gameInstallPath"] = "  D:\\DCS World  ";
    expect(roots.gameInstall()).toBe("D:\\DCS World");
  });

  it("is undefined when unset or blank, never a guess and never an empty string", () => {
    // Callers branch on undefined to mean "not found yet"; an empty string
    // would resolve {GameInstall} against the filesystem root. There is no
    // default either — a wrong guess points DCS Studio at a folder that is not
    // DCS, and the panels are written to say "unset" instead.
    expect(roots.gameInstall()).toBeUndefined();
    state.config["dcsStudio.gameInstallPath"] = "   ";
    expect(roots.gameInstall()).toBeUndefined();
  });
});

describe("dataDir", () => {
  it("prefers the configured data dir, trimmed", () => {
    state.config["dcsStudio.dataDir"] = "  E:\\ModData  ";
    expect(roots.dataDir()).toBe("E:\\ModData");
  });

  it("defaults under the user profile, outside DCS's own folders", () => {
    expect(roots.dataDir()).toBe("C:\\Users\\pilot\\DCSStudio\\mods");
  });

  it("falls back to the OS homedir when USERPROFILE is unset", () => {
    delete process.env.USERPROFILE;
    expect(roots.dataDir()).toBe("C:\\Users\\fallback\\DCSStudio\\mods");
  });

  it("ignores a whitespace-only setting", () => {
    state.config["dcsStudio.dataDir"] = "  ";
    expect(roots.dataDir()).toBe("C:\\Users\\pilot\\DCSStudio\\mods");
  });
});

describe("the port surface", () => {
  it("exposes the three roots the port promises", () => {
    state.config["dcsStudio.savedGamesPath"] = "D:\\SG\\DCS";
    state.config["dcsStudio.gameInstallPath"] = "D:\\DCS World";
    state.config["dcsStudio.dataDir"] = "E:\\ModData";

    expect(roots.savedGames()).toBe("D:\\SG\\DCS");
    expect(roots.gameInstall()).toBe("D:\\DCS World");
    expect(roots.dataDir()).toBe("E:\\ModData");
  });

  it("re-reads settings on every call, so a settings change takes effect live", () => {
    state.config["dcsStudio.savedGamesPath"] = "D:\\First";
    expect(roots.savedGames()).toBe("D:\\First");
    state.config["dcsStudio.savedGamesPath"] = "D:\\Second";
    expect(roots.savedGames()).toBe("D:\\Second");
  });

  it("shares one instance for the command handlers that cannot be injected", () => {
    // The plain-function commands (inject/eject/launch, the log and mission
    // panels) have nowhere to receive a port, so they import this instance.
    // It must be the same resolver, not a second copy of the rules — two
    // copies is exactly what issue #45 was.
    state.config["dcsStudio.savedGamesPath"] = "D:\\Shared\\DCS";
    expect(installRoots).toBeInstanceOf(VsCodeInstallRoots);
    expect(installRoots.savedGames()).toBe(roots.savedGames());
  });
});

// Restore the ambient environment for any suite that runs after this file.
process.on("exit", () => {
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});
