import { describe, expect, it } from "vitest";
import {
  destRelative,
  destStaysUnder,
  ROOT_TOKENS,
  staysUnder,
} from "../../../src/core/domain/pathContainment";
import { CONTAINMENT_CASES as CASES } from "../../support/pathContainmentCases";

// The containment predicate a hostile dcs-studio.toml is measured against
// (issue #16). The cases are not written here: all three implementations of the
// rule — this one, the webview's copy in media/manifest-core.js, and the in-sim
// bridge's path_guard.rs — read the same table, so a case cannot be added to
// one guard's tests and forgotten in another's.

describe("staysUnder — the shared case table", () => {
  it("carries cases in both directions", () => {
    // Guards the guard: an empty or half-loaded table would make every
    // assertion below pass vacuously.
    expect(CASES.accept.length).toBeGreaterThan(5);
    expect(CASES.reject.length).toBeGreaterThan(15);
  });

  it.each(CASES.accept)("accepts $path — $why", ({ path }) => {
    expect(staysUnder(path)).toBe(true);
  });

  it.each(CASES.reject)("rejects $path — $why", ({ path }) => {
    expect(staysUnder(path)).toBe(false);
  });
});

describe("destRelative — the shared dest table", () => {
  it("carries dest cases", () => {
    expect(CASES.dest.length).toBeGreaterThan(8);
  });

  // The manifest-facing half of the rule, and the half the table did not cover
  // until a native `{SavedGames}\Scripts\a.lua` turned out to be refused as a
  // traversal while a bare `Scripts\Hooks` was accepted. Each case states the
  // relative path a dest reduces to; the verdict is then whatever the
  // containment rule says about that path, so the two cannot disagree.
  it.each(CASES.dest)("reduces $dest to $relative — $why", ({ dest, relative }) => {
    expect(destRelative(dest)).toBe(relative);
    expect(destStaysUnder(dest)).toBe(staysUnder(relative));
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
