import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const existing = new Set<string>();
vi.mock("fs", () => ({ existsSync: (p: string) => existing.has(p) }));
vi.mock("os", () => ({ homedir: () => "C:\\Users\\fallback" }));

import { VsCodeInstallRoots } from "../../../src/adapters/vscode/installRoots";
import { gameInstallDir, savedGamesDir } from "../../../src/bridge/paths";
import { dataDir } from "../../../src/install/dataDir";

// Where DCS Studio believes DCS lives. Every install, link and bridge injection
// is resolved from these three answers, so the precedence rules — settings
// override, then a probed default, then a fixed fallback — are the difference
// between a mod landing in the user's DCS folder and landing somewhere else.

const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

beforeEach(() => {
  resetVscode();
  existing.clear();
  process.env.USERPROFILE = "C:\\Users\\pilot";
});

describe("savedGamesDir", () => {
  it("prefers the configured path, trimmed", () => {
    state.config["dcsStudio.savedGamesPath"] = "  D:\\Custom\\DCS  ";
    expect(savedGamesDir()).toBe("D:\\Custom\\DCS");
  });

  it("ignores a whitespace-only setting and falls back to detection", () => {
    state.config["dcsStudio.savedGamesPath"] = "   ";
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    expect(savedGamesDir()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("picks the stable DCS folder when both it and openbeta exist", () => {
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS");
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
    expect(savedGamesDir()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("falls back to the openbeta folder when only that exists", () => {
    existing.add("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
    expect(savedGamesDir()).toBe("C:\\Users\\pilot\\Saved Games\\DCS.openbeta");
  });

  it("returns the stable candidate when neither folder exists", () => {
    // Nothing detected: the caller shows a setup prompt, so this must still be
    // a sensible path rather than undefined.
    expect(savedGamesDir()).toBe("C:\\Users\\pilot\\Saved Games\\DCS");
  });

  it("uses the OS homedir when USERPROFILE is unset", () => {
    process.env.USERPROFILE = undefined as unknown as string;
    delete process.env.USERPROFILE;
    expect(savedGamesDir()).toBe("C:\\Users\\fallback\\Saved Games\\DCS");
  });
});

describe("gameInstallDir", () => {
  it("returns the configured install path, trimmed", () => {
    state.config["dcsStudio.gameInstallPath"] = "  D:\\DCS World  ";
    expect(gameInstallDir()).toBe("D:\\DCS World");
  });

  it("is undefined when unset or blank, never an empty string", () => {
    // Callers branch on undefined to mean "not found yet"; an empty string
    // would resolve {GameInstall} against the filesystem root.
    expect(gameInstallDir()).toBeUndefined();
    state.config["dcsStudio.gameInstallPath"] = "   ";
    expect(gameInstallDir()).toBeUndefined();
  });
});

describe("dataDir", () => {
  it("prefers the configured data dir, trimmed", () => {
    state.config["dcsStudio.dataDir"] = "  E:\\ModData  ";
    expect(dataDir()).toBe("E:\\ModData");
  });

  it("defaults under the user profile, outside DCS's own folders", () => {
    // Deliberately not under Saved Games: DCS scans that tree, and the raw
    // unpacked mod payloads must stay invisible to it.
    expect(dataDir()).toBe("C:\\Users\\pilot\\DCSStudio\\mods");
    expect(dataDir()).not.toContain("Saved Games");
  });

  it("falls back to the OS homedir when USERPROFILE is unset", () => {
    delete process.env.USERPROFILE;
    expect(dataDir()).toBe("C:\\Users\\fallback\\DCSStudio\\mods");
  });

  it("ignores a whitespace-only setting", () => {
    state.config["dcsStudio.dataDir"] = "  ";
    expect(dataDir()).toBe("C:\\Users\\pilot\\DCSStudio\\mods");
  });
});

describe("VsCodeInstallRoots", () => {
  it("exposes the three roots the port promises, from the same resolvers", () => {
    state.config["dcsStudio.savedGamesPath"] = "D:\\SG\\DCS";
    state.config["dcsStudio.gameInstallPath"] = "D:\\DCS World";
    state.config["dcsStudio.dataDir"] = "E:\\ModData";
    const roots = new VsCodeInstallRoots();

    expect(roots.savedGames()).toBe("D:\\SG\\DCS");
    expect(roots.gameInstall()).toBe("D:\\DCS World");
    expect(roots.dataDir()).toBe("E:\\ModData");
  });

  it("re-reads settings on every call, so a settings change takes effect live", () => {
    const roots = new VsCodeInstallRoots();
    state.config["dcsStudio.savedGamesPath"] = "D:\\First";
    expect(roots.savedGames()).toBe("D:\\First");
    state.config["dcsStudio.savedGamesPath"] = "D:\\Second";
    expect(roots.savedGames()).toBe("D:\\Second");
  });

  it("reports an unset game install as undefined", () => {
    expect(new VsCodeInstallRoots().gameInstall()).toBeUndefined();
  });
});

// Restore the ambient environment for any suite that runs after this file.
process.on("exit", () => {
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
});
