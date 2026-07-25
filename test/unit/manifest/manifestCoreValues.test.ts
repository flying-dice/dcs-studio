import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import DcsManifestCore from "../../../media/manifest-core.js";

const { parseVal, q, emitToml, splitDest, winJoin, resolveDest, emptyModel } = DcsManifestCore;

// Scalar coercion, dest-token resolution and the UMD wrapper — the parts of
// manifest-core the round-trip tests never reach because they only exercise
// string keys through parseToml/emitToml. resolveDest in particular is what
// turns a manifest's `{SavedGames}/Scripts/x` into the real path the installer
// links, so its token rules are load-bearing for every install.

describe("parseVal", () => {
  it("coerces TOML booleans to real booleans", () => {
    expect(parseVal("true")).toBe(true);
    expect(parseVal("false")).toBe(false);
  });

  it("coerces integers, including negatives", () => {
    expect(parseVal("42")).toBe(42);
    expect(parseVal("-7")).toBe(-7);
    expect(parseVal("0")).toBe(0);
  });

  it("does not coerce version-like or float-like values to numbers", () => {
    // "0.1.0" and "1.5" must survive as strings — a manifest version silently
    // becoming a number would corrupt every emit.
    expect(parseVal("0.1.0")).toBe("0.1.0");
    expect(parseVal("1.5")).toBe("1.5");
  });

  it("unquotes double-quoted strings and unescapes quotes and backslashes", () => {
    expect(parseVal('"plain"')).toBe("plain");
    expect(parseVal('"say \\"hi\\""')).toBe('say "hi"');
    expect(parseVal('"C:\\\\Games"')).toBe("C:\\Games");
  });

  it("unquotes single-quoted (literal) strings without unescaping", () => {
    expect(parseVal("'C:\\Games'")).toBe("C:\\Games");
  });

  it("leaves a bare token as-is", () => {
    expect(parseVal("bare")).toBe("bare");
  });

  it("parses inline arrays, recursing through parseVal for each element", () => {
    expect(parseVal('["--min", "-v"]')).toEqual(["--min", "-v"]);
    expect(parseVal("[1, 2, 3]")).toEqual([1, 2, 3]);
    expect(parseVal('[true, false, "x"]')).toEqual([true, false, "x"]);
    expect(parseVal("[]")).toEqual([]);
  });

  it("tolerates whitespace and a trailing comma inside an array", () => {
    expect(parseVal('[ "a" ,  "b" , ]')).toEqual(["a", "b"]);
  });
});

describe("q", () => {
  it("quotes and escapes backslashes before quotes", () => {
    expect(q("a")).toBe('"a"');
    expect(q('say "hi"')).toBe('"say \\"hi\\""');
    expect(q("C:\\Games")).toBe('"C:\\\\Games"');
  });

  it("renders null and undefined as an empty string, never the word null", () => {
    expect(q(null)).toBe('""');
    expect(q(undefined)).toBe('""');
  });
});

describe("emitToml — optional [project] keys", () => {
  it("omits version, author and description when they are empty", () => {
    const m = emptyModel();
    m.project = { name: "my-mod", version: "", author: "", description: "" };
    const out = emitToml(m);
    expect(out).toContain('name = "my-mod"');
    expect(out).not.toContain("version =");
    expect(out).not.toContain("author =");
    expect(out).not.toContain("description =");
  });

  it("emits author and description when they are set", () => {
    const m = emptyModel();
    m.project = {
      name: "my-mod",
      version: "1.2.3",
      author: "Pilot",
      description: "Does a thing",
    };
    const out = emitToml(m);
    expect(out).toContain('version = "1.2.3"');
    expect(out).toContain('author = "Pilot"');
    expect(out).toContain('description = "Does a thing"');
  });

  it("emits a [[requires_module]] id with and without the optional name", () => {
    const m = emptyModel();
    m.project.name = "my-mod";
    m.requires_module = [{ id: "WWII" }, { id: "FC3", name: "Flaming Cliffs 3" }];
    const out = emitToml(m);
    expect(out).toContain('id = "WWII"');
    expect(out).toContain('name = "Flaming Cliffs 3"');
    // The nameless entry must not borrow the next entry's name.
    expect(out.indexOf('id = "WWII"')).toBeLessThan(out.indexOf('id = "FC3"'));
  });

  it("passes unmodeled [project] keys through, quoting strings but not numbers", () => {
    const m = emptyModel();
    m.project.name = "my-mod";
    m.project.template = "mission-script";
    m.project.dcs_min_version = 2;
    const out = emitToml(m);
    expect(out).toContain('template = "mission-script"');
    expect(out).toContain("dcs_min_version = 2");
  });
});

describe("parseToml — tolerance inside a modeled section", () => {
  const { parseToml } = DcsManifestCore;

  it("skips comment-only and blank lines without dropping the section", () => {
    const model = parseToml(`[project]
# a comment line inside a modeled section
name = "my-mod"
`);
    expect(model.project.name).toBe("my-mod");
  });

  it("drops key/value lines that appear before any section header", () => {
    // A v1 limitation, stated in the parser: there is no section to attach a
    // bare leading pair to, so it is dropped rather than guessed at.
    const model = parseToml(`stray = "value"
[project]
name = "my-mod"
`);
    expect(model.project.name).toBe("my-mod");
    expect(model.project).not.toHaveProperty("stray");
  });

  it("ignores a line that is not key = value rather than throwing", () => {
    // Hand-edited manifests do contain junk; the Rust parser is tolerant and
    // this one must match it, or the form would refuse to open the file.
    const model = parseToml(`[project]
name = "my-mod"
this line is not a pair
`);
    expect(model.project.name).toBe("my-mod");
  });
});

describe("splitDest", () => {
  it("splits a {SavedGames} dest into token and remainder", () => {
    expect(splitDest("{SavedGames}/Scripts/a.lua")).toEqual({
      root: "{SavedGames}",
      rest: "Scripts/a.lua",
    });
  });

  it("splits a {GameInstall} dest", () => {
    expect(splitDest("{GameInstall}/Mods/x")).toEqual({ root: "{GameInstall}", rest: "Mods/x" });
  });

  it("defaults an untokenised dest to {SavedGames}", () => {
    // A manifest that forgets the token still links somewhere safe (the write
    // dir) rather than resolving against the read-only game install.
    expect(splitDest("Scripts/a.lua")).toEqual({ root: "{SavedGames}", rest: "Scripts/a.lua" });
    expect(splitDest("/Scripts/a.lua")).toEqual({ root: "{SavedGames}", rest: "Scripts/a.lua" });
  });

  it("strips only the leading slash directly after the token", () => {
    expect(splitDest("{SavedGames}Scripts")).toEqual({ root: "{SavedGames}", rest: "Scripts" });
  });
});

describe("winJoin", () => {
  it("joins with a backslash and converts forward slashes", () => {
    expect(winJoin("C:\\SG\\DCS", "Scripts/a.lua")).toBe("C:\\SG\\DCS\\Scripts\\a.lua");
  });

  it("collapses redundant separators at the seam", () => {
    expect(winJoin("C:\\SG\\DCS\\", "/Scripts")).toBe("C:\\SG\\DCS\\Scripts");
    expect(winJoin("C:/SG/DCS//", "Scripts")).toBe("C:/SG/DCS\\Scripts");
  });

  it("returns the base alone when there is no remainder", () => {
    expect(winJoin("C:\\SG\\DCS", "")).toBe("C:\\SG\\DCS");
  });
});

describe("resolveDest", () => {
  const roots = { savedGames: "C:\\SG\\DCS", gameInstall: "D:\\DCS World" };

  it("resolves {SavedGames} against the write dir", () => {
    expect(resolveDest("{SavedGames}/Scripts/a.lua", roots)).toBe(
      path.join("C:\\SG\\DCS", "Scripts", "a.lua"),
    );
  });

  it("resolves {GameInstall} against the game dir", () => {
    expect(resolveDest("{GameInstall}/Mods/x", roots)).toBe(
      path.join("D:\\DCS World", "Mods", "x"),
    );
  });

  it("returns null for {GameInstall} when the game install is unknown", () => {
    // The caller renders this as "can't resolve yet" rather than linking into
    // a bogus path — a mod that targets the install dir is not installable
    // until Setup has found DCS.
    expect(resolveDest("{GameInstall}/Mods/x", { savedGames: "C:\\SG\\DCS" })).toBeNull();
    expect(resolveDest("{GameInstall}/Mods/x", { ...roots, gameInstall: "" })).toBeNull();
  });

  it("resolves an untokenised dest against Saved Games", () => {
    expect(resolveDest("Scripts/a.lua", roots)).toBe(path.join("C:\\SG\\DCS", "Scripts", "a.lua"));
  });
});

describe("UMD wrapper", () => {
  it("attaches the API to the global when there is no module.exports", () => {
    // The webview loads this file as a plain <script>, where `module` is
    // undefined and the API has to land on `self`. Node tests always take the
    // CommonJS branch, so the browser branch is only reachable by evaluating
    // the source in a context without `module` — which is exactly what a
    // webview is.
    const src = readFileSync(new URL("../../../media/manifest-core.js", import.meta.url), "utf8");
    const sandbox: { self?: Record<string, unknown> } = {};
    sandbox.self = sandbox as Record<string, unknown>;
    runInNewContext(src, sandbox);

    const api = (sandbox.self as { DcsManifestCore?: typeof DcsManifestCore }).DcsManifestCore;
    expect(api).toBeDefined();
    expect(api?.resolveDest("{SavedGames}/x", { savedGames: "C:\\SG" })).toBe("C:\\SG\\x");
  });
});
