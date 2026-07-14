import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DetectService } from "../../src/core/app/detectService";
import type { EnvPort } from "../../src/core/ports/env";
import type { FileSystemPort } from "../../src/core/ports/filesystem";
import type { RegistryPort } from "../../src/core/ports/registry";

const HOME = "C:\\Users\\pilot";
const SAVED = path.join(HOME, "Saved Games");

/** Fake FileSystemPort driven by a set of directories and a set of files. */
class FakeFs implements FileSystemPort {
  constructor(
    private readonly dirs: Set<string>,
    private readonly plainFiles: Set<string> = new Set(),
  ) {}
  async readText(): Promise<string> {
    throw new Error("not used");
  }
  async writeText(): Promise<void> {}
  async exists(p: string): Promise<boolean> {
    return this.dirs.has(p) || this.plainFiles.has(p);
  }
  async isDirectory(p: string): Promise<boolean> {
    return this.dirs.has(p);
  }
  async readDir(p: string): Promise<string[]> {
    if (!this.dirs.has(p)) throw new Error(`ENOENT: ${p}`);
    const children = new Set<string>();
    for (const d of [...this.dirs, ...this.plainFiles]) {
      if (d !== p && d.startsWith(`${p}\\`)) children.add(d.slice(p.length + 1).split("\\")[0]);
    }
    return [...children].sort();
  }
  async remove(): Promise<void> {}
  async mkdirp(): Promise<void> {}
  async copy(): Promise<void> {}
}

class FakeRegistry implements RegistryPort {
  calls: Array<[string, string, string]> = [];
  constructor(private readonly results: Record<string, Array<[string, string]>> = {}) {}
  async queryValues(
    hive: string,
    subKey: string,
    valueName: string,
  ): Promise<Array<[string, string]>> {
    this.calls.push([hive, subKey, valueName]);
    return this.results[`${hive}\\${subKey}`] ?? [];
  }
}

function fakeEnv(overrides?: Partial<EnvPort>): EnvPort {
  return {
    homedir: () => HOME,
    userProfile: () => HOME,
    programFilesCandidates: () => [],
    ...overrides,
  };
}

function svc(
  fs: FileSystemPort,
  registry: RegistryPort = new FakeRegistry(),
  env: EnvPort = fakeEnv(),
) {
  return new DetectService({ registry, fs, env });
}

describe("DetectService.detectSavedGames", () => {
  it("returns [] when Saved Games is unreadable", async () => {
    const out = await svc(new FakeFs(new Set())).detectSavedGames();
    expect(out).toEqual([]);
  });

  it("keeps only DCS/DCS.* directory entries", async () => {
    const fs = new FakeFs(
      new Set([
        SAVED,
        path.join(SAVED, "DCS"),
        path.join(SAVED, "DCS.openbeta"),
        path.join(SAVED, "Diablo IV"),
        path.join(SAVED, "DCSX"),
      ]),
      new Set([path.join(SAVED, "DCS.stray-file")]), // a file, not a dir → skipped
    );
    const out = await svc(fs).detectSavedGames();
    expect(out.map((c) => c.name)).toEqual(["DCS", "DCS.openbeta"]);
  });

  it("marks validity on the Config subdir and orders DCS first, then variants A→Z", async () => {
    const fs = new FakeFs(
      new Set([
        SAVED,
        path.join(SAVED, "DCS.server"),
        path.join(SAVED, "DCS.server", "Config"),
        path.join(SAVED, "DCS.alpha"),
        path.join(SAVED, "DCS"),
        path.join(SAVED, "DCS", "Config"),
      ]),
    );
    const out = await svc(fs).detectSavedGames();
    expect(out).toEqual([
      {
        path: path.join(SAVED, "DCS"),
        name: "DCS",
        valid: true,
        detail: "has Config",
      },
      {
        path: path.join(SAVED, "DCS.alpha"),
        name: "DCS.alpha",
        valid: false,
        detail: "no Config yet — run DCS once",
      },
      {
        path: path.join(SAVED, "DCS.server"),
        name: "DCS.server",
        valid: true,
        detail: "has Config",
      },
    ]);
  });

  it("falls back to homedir when USERPROFILE is unset", async () => {
    const altHome = "D:\\home\\pilot";
    const altSaved = path.join(altHome, "Saved Games");
    const fs = new FakeFs(new Set([altSaved, path.join(altSaved, "DCS")]));
    const env = fakeEnv({ userProfile: () => undefined, homedir: () => altHome });
    const out = await svc(fs, new FakeRegistry(), env).detectSavedGames();
    expect(out.map((c) => c.path)).toEqual([path.join(altSaved, "DCS")]);
  });
});

describe("DetectService.detectGameInstalls", () => {
  const REG_ROOT = "C:\\Program Files\\Eagle Dynamics\\DCS World";

  it("queries HKCU and HKLM Eagle Dynamics for Path values", async () => {
    const registry = new FakeRegistry();
    await svc(new FakeFs(new Set()), registry).detectGameInstalls();
    expect(registry.calls).toEqual([
      ["HKCU", "Software\\Eagle Dynamics", "Path"],
      ["HKLM", "SOFTWARE\\Eagle Dynamics", "Path"],
    ]);
  });

  it("returns registry installs with bin\\DCS.exe validity", async () => {
    const registry = new FakeRegistry({
      "HKCU\\Software\\Eagle Dynamics": [["DCS World", REG_ROOT]],
    });
    const fs = new FakeFs(new Set([REG_ROOT]), new Set([path.join(REG_ROOT, "bin", "DCS.exe")]));
    const out = await svc(fs, registry).detectGameInstalls();
    expect(out).toEqual([
      { path: REG_ROOT, name: "DCS World", valid: true, detail: "bin\\DCS.exe found" },
    ]);
  });

  it("marks installs without bin\\DCS.exe invalid", async () => {
    const registry = new FakeRegistry({
      "HKLM\\SOFTWARE\\Eagle Dynamics": [["DCS World OpenBeta", "D:\\DCS"]],
    });
    const fs = new FakeFs(new Set(["D:\\DCS"]));
    const out = await svc(fs, registry).detectGameInstalls();
    expect(out).toEqual([
      { path: "D:\\DCS", name: "DCS World OpenBeta", valid: false, detail: "no bin\\DCS.exe" },
    ]);
  });

  it("skips empty and non-directory registry paths", async () => {
    const registry = new FakeRegistry({
      "HKCU\\Software\\Eagle Dynamics": [
        ["Broken", ""],
        ["Gone", "Z:\\nowhere"],
      ],
    });
    const out = await svc(new FakeFs(new Set()), registry).detectGameInstalls();
    expect(out).toEqual([]);
  });

  it("dedupes registry vs Program Files case-insensitively, registry name winning", async () => {
    const registry = new FakeRegistry({
      "HKCU\\Software\\Eagle Dynamics": [
        ["My DCS", REG_ROOT.toUpperCase()], // same folder, different case
      ],
    });
    const fs = new FakeFs(
      new Set([REG_ROOT, REG_ROOT.toUpperCase()]),
      new Set([path.join(REG_ROOT.toUpperCase(), "bin", "DCS.exe")]),
    );
    const out = await svc(fs, registry).detectGameInstalls();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("My DCS"); // first (registry) hit wins the dedup slot
  });

  it("dedupes duplicate registry entries across hives", async () => {
    const registry = new FakeRegistry({
      "HKCU\\Software\\Eagle Dynamics": [["DCS World", REG_ROOT]],
      "HKLM\\SOFTWARE\\Eagle Dynamics": [["DCS World", REG_ROOT]],
    });
    const fs = new FakeFs(new Set([REG_ROOT]));
    const out = await svc(fs, registry).detectGameInstalls();
    expect(out).toHaveLength(1);
  });

  it("probes Program Files roots and sorts results by name", async () => {
    const server = "C:\\Program Files\\Eagle Dynamics\\DCS World Server";
    const openBeta = "D:\\Program Files\\Eagle Dynamics\\DCS World OpenBeta";
    const fs = new FakeFs(
      new Set([server, openBeta]),
      new Set([path.join(server, "bin", "DCS.exe")]),
    );
    const out = await svc(fs).detectGameInstalls();
    expect(out).toEqual([
      { path: openBeta, name: "DCS World OpenBeta", valid: false, detail: "no bin\\DCS.exe" },
      { path: server, name: "DCS World Server", valid: true, detail: "bin\\DCS.exe found" },
    ]);
  });
});
