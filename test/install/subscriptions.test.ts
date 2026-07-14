import { describe, expect, it } from "vitest";
import {
  dataDirName,
  isUpToDate,
  ledgerKey,
  MANIFEST,
  renderUninstallScript,
  type Subscription,
  sortedByName,
  toModDto,
} from "../../src/core/domain/subscriptions";

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  repo: "Owner/Repo",
  name: "My Mod",
  tag: "v1.0.0",
  dir: "D:\\data\\Owner__Repo",
  enabled: false,
  links: [],
  entrypoints: [],
  missionScripts: [],
  ...over,
});

describe("constants", () => {
  it("names the manifest file", () => {
    expect(MANIFEST).toBe("dcs-studio.toml");
  });
});

describe("ledgerKey", () => {
  it("lowercases the repo", () => {
    expect(ledgerKey("Owner/Repo")).toBe("owner/repo");
    expect(ledgerKey("already/lower")).toBe("already/lower");
  });
});

describe("dataDirName", () => {
  it("replaces forward and back slashes with __", () => {
    expect(dataDirName("owner/repo")).toBe("owner__repo");
    expect(dataDirName("owner\\repo")).toBe("owner__repo");
  });

  it("preserves case (distinct from the ledger key)", () => {
    expect(dataDirName("Owner/Repo")).toBe("Owner__Repo");
  });
});

describe("toModDto", () => {
  it("projects the webview fields, counts links, and carries entrypoints", () => {
    const s = sub({
      enabled: true,
      links: [
        { id: "a:0", dest: "C:\\SG\\x" },
        { id: "a:1", dest: "C:\\SG\\y" },
      ],
      entrypoints: [{ id: "srs", name: "SRS", exe: "Server/SR.exe" }],
    });
    expect(toModDto(s)).toEqual({
      repo: "Owner/Repo",
      name: "My Mod",
      tag: "v1.0.0",
      enabled: true,
      dir: "D:\\data\\Owner__Repo",
      links: 2,
      entrypoints: [{ id: "srs", name: "SRS", exe: "Server/SR.exe" }],
    });
  });

  it("defaults entrypoints to [] for a legacy ledger entry that predates the field", () => {
    const legacy = sub();
    delete (legacy as Partial<Subscription>).entrypoints;
    expect(toModDto(legacy).entrypoints).toEqual([]);
  });
});

describe("isUpToDate", () => {
  it("is true only when the release tag equals the subscribed tag", () => {
    expect(isUpToDate(sub({ tag: "v2" }), "v2")).toBe(true);
    expect(isUpToDate(sub({ tag: "v1" }), "v2")).toBe(false);
  });
});

describe("sortedByName", () => {
  it("sorts by display name", () => {
    const subs = {
      "b/b": sub({ repo: "b/b", name: "Zulu" }),
      "a/a": sub({ repo: "a/a", name: "alpha" }),
      "c/c": sub({ repo: "c/c", name: "Mike" }),
    };
    expect(sortedByName(subs).map((s) => s.name)).toEqual(["alpha", "Mike", "Zulu"]);
  });
});

describe("renderUninstallScript", () => {
  const DATA = "D:\\data";
  const SUBS_FILE = "D:\\data\\subscriptions.json";

  const HEADER = [
    "@echo off",
    "REM ============================================================",
    "REM  DCS Studio — clean uninstall",
    "REM  Removes every mod link from your DCS folders, then the",
    "REM  unpacked mod data. Run this if things break or to wipe all",
    "REM  DCS Studio mods in one go. Maintained by the extension.",
    "REM ============================================================",
    "setlocal",
    "echo Removing DCS Studio mod links...",
  ];
  const FOOTER = (subsFile: string) => [
    `if exist "${subsFile}" del /f /q "${subsFile}"`,
    "echo.",
    "echo Done. All DCS Studio mods have been removed.",
    "pause",
  ];

  it("renders the empty-ledger script byte-exactly (CRLF + trailing newline)", () => {
    const expected = `${[...HEADER, "echo Removing unpacked mod data...", ...FOOTER(SUBS_FILE)].join("\r\n")}\r\n`;
    expect(renderUninstallScript({}, DATA, SUBS_FILE)).toBe(expected);
  });

  it("emits a junction-vs-file removal line per link and an rmdir /s per data dir", () => {
    const subs: Record<string, Subscription> = {
      "owner/repo": sub({
        dir: "D:\\data\\Owner__Repo",
        links: [
          { id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Mods\\tech\\X" },
          { id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Scripts\\x.lua" },
        ],
      }),
      "other/mod": sub({ repo: "Other/Mod", dir: "D:\\data\\Other__Mod", links: [] }),
    };
    const expected = `${[
      ...HEADER,
      `if exist "C:\\SG\\DCS\\Mods\\tech\\X\\" ( rmdir "C:\\SG\\DCS\\Mods\\tech\\X" ) else ( if exist "C:\\SG\\DCS\\Mods\\tech\\X" del /f /q "C:\\SG\\DCS\\Mods\\tech\\X" )`,
      `if exist "C:\\SG\\DCS\\Scripts\\x.lua\\" ( rmdir "C:\\SG\\DCS\\Scripts\\x.lua" ) else ( if exist "C:\\SG\\DCS\\Scripts\\x.lua" del /f /q "C:\\SG\\DCS\\Scripts\\x.lua" )`,
      "echo Removing unpacked mod data...",
      `if exist "D:\\data\\Owner__Repo" rmdir /s /q "D:\\data\\Owner__Repo"`,
      `if exist "D:\\data\\Other__Mod" rmdir /s /q "D:\\data\\Other__Mod"`,
      ...FOOTER(SUBS_FILE),
    ].join("\r\n")}\r\n`;
    expect(renderUninstallScript(subs, DATA, SUBS_FILE)).toBe(expected);
  });

  it("strips embedded double quotes from paths before quoting", () => {
    const subs: Record<string, Subscription> = {
      "q/q": sub({ dir: 'D:\\da"ta\\mod', links: [{ id: "q:0", dest: 'C:\\we"ird' }] }),
    };
    const out = renderUninstallScript(subs, DATA, SUBS_FILE);
    expect(out).toContain('if exist "C:\\weird\\" ( rmdir "C:\\weird" )');
    expect(out).toContain('if exist "D:\\data\\mod" rmdir /s /q "D:\\data\\mod"');
    expect(out).not.toContain('we"ird');
  });

  it("uses CRLF for every line and ends with exactly one trailing CRLF", () => {
    const out = renderUninstallScript({}, DATA, SUBS_FILE);
    expect(out.endsWith("pause\r\n")).toBe(true);
    expect(out.split("\r\n").join("")).not.toContain("\n");
  });
});
