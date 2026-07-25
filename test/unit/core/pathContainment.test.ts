import { describe, expect, it } from "vitest";
import {
  destRelative,
  destStaysUnder,
  ROOT_TOKENS,
  staysUnder,
} from "../../../src/core/domain/pathContainment";

// The containment predicate a hostile dcs-studio.toml is measured against
// (issue #16). These cases are deliberately the same ones the bridge's
// path_guard.rs asserts — the two guards are mirrors, so the evidence that they
// agree is that they are held to the same table. The webview's third copy is
// checked against this one in test/unit/manifest/manifestCoreValues.test.ts.

describe("staysUnder — accepts", () => {
  it("ordinary relative paths on either separator", () => {
    expect(staysUnder("dcs.log")).toBe(true);
    expect(staysUnder("Logs/dcs.log")).toBe(true);
    expect(staysUnder("Logs\\dcs.log")).toBe(true);
    expect(staysUnder("a/b/c/d.json")).toBe(true);
  });

  it("a `.` segment, which is a no-op rather than an escape", () => {
    expect(staysUnder("./dcs.log")).toBe(true);
    expect(staysUnder("a/./b")).toBe(true);
  });
});

describe("staysUnder — rejects", () => {
  it("parent traversal on either separator, anywhere in the path", () => {
    expect(staysUnder("..")).toBe(false);
    expect(staysUnder("../secrets")).toBe(false);
    expect(staysUnder("..\\secrets")).toBe(false);
    expect(staysUnder("Logs/../../secrets")).toBe(false);
    expect(staysUnder("Logs\\..\\..\\secrets")).toBe(false);
    // Buried in the middle, after legitimate-looking segments.
    expect(staysUnder("a/b/../../../../etc/passwd")).toBe(false);
  });

  it("absolute and UNC paths", () => {
    expect(staysUnder("/etc/passwd")).toBe(false);
    expect(staysUnder("\\Windows\\System32")).toBe(false);
    expect(staysUnder("\\\\server\\share\\x")).toBe(false);
    expect(staysUnder("//server/share/x")).toBe(false);
  });

  it("drive prefixes and NTFS data streams on every host", () => {
    // The case a component-based guard gets wrong off-Windows: on Linux these
    // parse as one ordinary component and would be accepted.
    expect(staysUnder("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBe(false);
    expect(staysUnder("C:/Windows")).toBe(false);
    expect(staysUnder("C:relative")).toBe(false);
    // An alternate data stream writes hidden content beside a file.
    expect(staysUnder("notes.txt:hidden")).toBe(false);
    expect(staysUnder("a/b.txt:$DATA")).toBe(false);
  });

  it("empty, separator-only and dot-only input", () => {
    expect(staysUnder("")).toBe(false);
    expect(staysUnder(".")).toBe(false);
    expect(staysUnder("./.")).toBe(false);
    expect(staysUnder("/")).toBe(false);
    expect(staysUnder("\\")).toBe(false);
  });

  it("doubled and trailing separators rather than silently collapsing them", () => {
    expect(staysUnder("a//b")).toBe(false);
    expect(staysUnder("a/")).toBe(false);
  });
});

describe("destRelative", () => {
  it("strips a leading root token and one root-relative separator", () => {
    expect(destRelative("{SavedGames}/Scripts/a.lua")).toBe("Scripts/a.lua");
    expect(destRelative("{GameInstall}/Mods/x")).toBe("Mods/x");
    // No separator after the token is tolerated the same way splitDest is.
    expect(destRelative("{SavedGames}Scripts")).toBe("Scripts");
  });

  it("treats an untokened dest as root-relative, with or without a leading slash", () => {
    expect(destRelative("Scripts/a.lua")).toBe("Scripts/a.lua");
    expect(destRelative("/Scripts/a.lua")).toBe("Scripts/a.lua");
  });

  it("names both roots the manifest may target", () => {
    expect(ROOT_TOKENS).toEqual(["{SavedGames}", "{GameInstall}"]);
  });
});

describe("destStaysUnder", () => {
  it("accepts a dest under either root, and a root-relative one", () => {
    expect(destStaysUnder("{SavedGames}/Scripts/a.lua")).toBe(true);
    expect(destStaysUnder("{GameInstall}/Mods/x")).toBe(true);
    // A leading separator names the root itself, not the filesystem root — it
    // is stripped before the check, exactly as resolveDest joins it.
    expect(destStaysUnder("/Scripts/Hooks")).toBe(true);
  });

  it("rejects the shapes issue #16 reported, under either root", () => {
    expect(destStaysUnder("{SavedGames}/../../Windows/System32/evil.dll")).toBe(false);
    expect(destStaysUnder("{GameInstall}/../../Windows/System32/evil.dll")).toBe(false);
    expect(destStaysUnder("{SavedGames}/notes.txt:hidden")).toBe(false);
  });

  it("rejects a drive-prefixed or UNC dest that no token pins under a root", () => {
    expect(destStaysUnder("C:/Windows/System32/evil")).toBe(false);
    expect(destStaysUnder("//server/share/payload")).toBe(false);
  });

  it("rejects a dest that is only its root token", () => {
    // Linking over the whole Saved Games folder is not a destination under it.
    expect(destStaysUnder("{SavedGames}")).toBe(false);
    expect(destStaysUnder("{SavedGames}/")).toBe(false);
  });
});
