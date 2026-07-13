import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  parseRegistryQuery,
  REGISTRY_INSTALL_KEYS,
  isDcsSavedName,
  compareSavedNames,
  savedGameDetail,
  programFilesInstallRoots,
  installDetail,
  compareInstallNames,
  roleProbePath,
} from "../../src/core/domain/dcsDetect";

// Real `reg query "HKCU\Software\Eagle Dynamics" /s /v Path` shaped stdout (CRLF,
// blank leading line, indented value rows).
const REG_STDOUT_CRLF = [
  "",
  "HKEY_CURRENT_USER\\Software\\Eagle Dynamics\\DCS World",
  "    Path    REG_SZ    C:\\Program Files\\Eagle Dynamics\\DCS World",
  "",
  "HKEY_CURRENT_USER\\Software\\Eagle Dynamics\\DCS World OpenBeta",
  "    Path    REG_SZ    D:\\Games\\DCS World OpenBeta  ",
  "",
  "End of search: 2 match(es) found.",
  "",
].join("\r\n");

describe("parseRegistryQuery", () => {
  it("parses CRLF reg.exe output into [subkey, value] pairs", () => {
    expect(parseRegistryQuery(REG_STDOUT_CRLF, "Path")).toEqual([
      ["DCS World", "C:\\Program Files\\Eagle Dynamics\\DCS World"],
      ["DCS World OpenBeta", "D:\\Games\\DCS World OpenBeta"],
    ]);
  });

  it("parses LF-only output identically", () => {
    expect(parseRegistryQuery(REG_STDOUT_CRLF.replace(/\r\n/g, "\n"), "Path")).toEqual([
      ["DCS World", "C:\\Program Files\\Eagle Dynamics\\DCS World"],
      ["DCS World OpenBeta", "D:\\Games\\DCS World OpenBeta"],
    ]);
  });

  it("matches the value name case-insensitively and tolerates key-line indentation", () => {
    const out = parseRegistryQuery(
      "  hkey_local_machine\\SOFTWARE\\Eagle Dynamics\\DCS World\n    path    REG_SZ    E:\\DCS\n",
      "Path",
    );
    expect(out).toEqual([["DCS World", "E:\\DCS"]]);
  });

  it("ignores a value row seen before any HKEY_ line", () => {
    expect(parseRegistryQuery("    Path    REG_SZ    C:\\Orphan\n", "Path")).toEqual([]);
  });

  it("ignores non-matching rows, other value types, and empty input", () => {
    expect(parseRegistryQuery("", "Path")).toEqual([]);
    expect(
      parseRegistryQuery(
        "HKEY_CURRENT_USER\\Software\\Eagle Dynamics\\DCS World\n    Path    REG_DWORD    0x1\n    Other    REG_SZ    x\n",
        "Path",
      ),
    ).toEqual([]);
  });

  it("keeps only the last key segment as the name", () => {
    const out = parseRegistryQuery(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Eagle Dynamics\\DCS World Server\n    Path    REG_SZ    C:\\Server\n",
      "Path",
    );
    expect(out).toEqual([["DCS World Server", "C:\\Server"]]);
  });
});

describe("REGISTRY_INSTALL_KEYS", () => {
  it("probes HKCU then HKLM Eagle Dynamics keys", () => {
    expect(REGISTRY_INSTALL_KEYS).toEqual([
      ["HKCU", "Software\\Eagle Dynamics"],
      ["HKLM", "SOFTWARE\\Eagle Dynamics"],
    ]);
  });
});

describe("isDcsSavedName", () => {
  it("accepts DCS and DCS.<variant>", () => {
    expect(isDcsSavedName("DCS")).toBe(true);
    expect(isDcsSavedName("DCS.openbeta")).toBe(true);
    expect(isDcsSavedName("DCS.server")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isDcsSavedName("DCSX")).toBe(false);
    expect(isDcsSavedName("dcs")).toBe(false);
    expect(isDcsSavedName("Diablo")).toBe(false);
  });
});

describe("compareSavedNames", () => {
  it("orders plain DCS first, then variants alphabetically", () => {
    const names = ["DCS.server", "DCS.openbeta", "DCS", "DCS.alpha"];
    expect([...names].sort(compareSavedNames)).toEqual([
      "DCS",
      "DCS.alpha",
      "DCS.openbeta",
      "DCS.server",
    ]);
  });
});

describe("savedGameDetail", () => {
  it("maps Config presence to validity and detail text", () => {
    expect(savedGameDetail(true)).toEqual({ valid: true, detail: "has Config" });
    expect(savedGameDetail(false)).toEqual({
      valid: false,
      detail: "no Config yet — run DCS once",
    });
  });
});

describe("programFilesInstallRoots", () => {
  it("probes C/D/E drives for the three DCS variants, in drive-major order", () => {
    const roots = programFilesInstallRoots();
    expect(roots).toHaveLength(9);
    expect(roots[0]).toEqual({
      name: "DCS World",
      root: "C:\\Program Files\\Eagle Dynamics\\DCS World",
    });
    expect(roots[2]).toEqual({
      name: "DCS World Server",
      root: "C:\\Program Files\\Eagle Dynamics\\DCS World Server",
    });
    expect(roots[8]).toEqual({
      name: "DCS World Server",
      root: "E:\\Program Files\\Eagle Dynamics\\DCS World Server",
    });
    expect(new Set(roots.map((r) => r.root)).size).toBe(9);
  });
});

describe("installDetail", () => {
  it("maps bin\\DCS.exe presence to validity and detail text", () => {
    expect(installDetail(true)).toEqual({ valid: true, detail: "bin\\DCS.exe found" });
    expect(installDetail(false)).toEqual({ valid: false, detail: "no bin\\DCS.exe" });
  });
});

describe("compareInstallNames", () => {
  it("orders by display name", () => {
    expect(["DCS World Server", "DCS World"].sort(compareInstallNames)).toEqual([
      "DCS World",
      "DCS World Server",
    ]);
  });
});

describe("roleProbePath", () => {
  it("install → bin\\DCS.exe under the target", () => {
    expect(roleProbePath("install", "C:\\DCS")).toBe(path.join("C:\\DCS", "bin", "DCS.exe"));
  });
  it("data → null (any writable folder is fine)", () => {
    expect(roleProbePath("data", "C:\\anything")).toBeNull();
  });
  it("sevenzip → the target itself", () => {
    expect(roleProbePath("sevenzip", "C:\\7z\\7z.exe")).toBe("C:\\7z\\7z.exe");
  });
  it("saved and undefined → the Config subdir", () => {
    expect(roleProbePath("saved", "C:\\SG\\DCS")).toBe(path.join("C:\\SG\\DCS", "Config"));
    expect(roleProbePath(undefined, "C:\\SG\\DCS")).toBe(path.join("C:\\SG\\DCS", "Config"));
  });
});
