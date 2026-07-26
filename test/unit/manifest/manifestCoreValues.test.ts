import { readFileSync } from "node:fs";
import { win32 as path } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import DcsManifestCore, { type ManifestArraySection } from "../../../media/manifest-core.js";
import {
  destStaysUnder as domainDestStaysUnder,
  staysUnder as domainStaysUnder,
} from "../../../src/core/domain/pathContainment";
import { ALL_CONTAINMENT_PATHS, CONTAINMENT_CASES } from "../../support/pathContainmentCases";

const {
  parseVal,
  q,
  emitToml,
  splitDest,
  winJoin,
  staysUnder,
  destStaysUnder,
  resolveDest,
  emptyModel,
} = DcsManifestCore;

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

describe("parseToml — [project] scalars are normalised to text", () => {
  const { parseToml, emitToml } = DcsManifestCore;

  // TOML is typed and `name = 2024` is a perfectly valid integer, but every
  // consumer of the modeled [project] fields treats them as strings and calls
  // .trim() on them — the form's issues() and publish preflight both did, and
  // both threw. The parser is the one boundary that can make them all safe.
  it.each([
    "name",
    "version",
    "author",
    "description",
  ])("keeps a bare integer %s as its literal text", (key) => {
    const model = parseToml(`[project]\n${key} = 2024\n`);
    expect(model.project[key]).toBe("2024");
    // The `as string` is the claim under test: a consumer that believes the
    // modeled fields are text calls .trim() on them, and this is what would
    // throw if the parser handed back the integer TOML says it is.
    expect(() => (model.project[key] as string).trim()).not.toThrow();
  });

  it.each([
    ["a negative integer", "-7", "-7"],
    ["a float", "1.5", "1.5"],
    ["true", "true", "true"],
    ["false", "false", "false"],
    ["an inline array", '["a", "b"]', '["a", "b"]'],
  ])("keeps %s name as its literal text", (_label, written, expected) => {
    expect(parseToml(`[project]\nname = ${written}\n`).project.name).toBe(expected);
  });

  it("still unquotes a normal quoted string", () => {
    const model = parseToml(`[project]\nname = "my-mod"\nversion = "0.1.0"\n`);
    expect(model.project).toMatchObject({ name: "my-mod", version: "0.1.0" });
  });

  it("re-emits a numeric name as a quoted string that reparses identically", () => {
    const once = emitToml(parseToml("[project]\nname = 2024\n"));
    expect(once).toContain('name = "2024"');
    expect(emitToml(parseToml(once))).toBe(once);
  });

  it("leaves unmodeled [project] keys typed so they round-trip unchanged", () => {
    // Only the four modeled fields are text-normalised; a key the form does not
    // edit keeps its TOML type, and emitToml writes it back without quotes.
    const model = parseToml("[project]\nname = 2024\ndcs_min_version = 2\nbeta = true\n");
    expect(model.project.dcs_min_version).toBe(2);
    expect(model.project.beta).toBe(true);
    const out = emitToml(model);
    expect(out).toContain("dcs_min_version = 2");
    expect(out).toContain("beta = true");
  });

  // The array sections need the same protection, and for a worse reason: the
  // form's issues() calls .trim() on bundle.path and mission_script.name, and
  // splitDest() calls .startsWith() on symlink.dest. render() assigns
  // state.model BEFORE building the HTML, so one numeric row leaves the form
  // permanently blank and every later message re-throws on the same row.
  it.each<[ManifestArraySection, string]>([
    ["bundle", "path"],
    ["symlink", "source"],
    ["symlink", "dest"],
    ["requires_module", "id"],
    ["requires_module", "name"],
    ["entrypoint", "id"],
    ["entrypoint", "name"],
    ["entrypoint", "exe"],
    ["mission_script", "name"],
    ["mission_script", "purpose"],
    ["mission_script", "path"],
    ["mission_script", "run_on"],
  ])("keeps a bare integer [[%s]].%s as its literal text", (section, key) => {
    const model = parseToml(`[[${section}]]\n${key} = 2024\n`);
    const row = model[section][0];
    expect(row[key]).toBe("2024");
    // As above: the cast states what every consumer of a modeled row assumes,
    // and the assertion is that the runtime value actually honours it.
    expect(() => (row[key] as string).trim()).not.toThrow();
  });

  it("survives a fully numeric manifest without a type error", () => {
    // The whole point: every modeled text field written as a TOML integer, and
    // nothing downstream throws.
    const model = parseToml(
      [
        "[project]",
        "name = 1",
        "[[bundle]]",
        "path = 2",
        "[[symlink]]",
        "source = 3",
        "dest = 4",
      ].join("\n"),
    );
    expect(() => splitDest(model.symlink[0].dest)).not.toThrow();
    expect(model.bundle[0].path.trim()).toBe("2");
  });

  it("leaves unmodeled keys in array sections typed so they round-trip", () => {
    // Same rule as [project]: only the keys the form edits are normalised.
    const model = parseToml("[[bundle]]\npath = 2\noptional = true\nweight = 3\n");
    expect(model.bundle[0]).toMatchObject({ path: "2", optional: true, weight: 3 });
  });

  it("normalises nothing in an unmodeled section", () => {
    // [lints] and friends are captured verbatim into extras, never parsed.
    const model = parseToml("[lints]\nname = 2024\n");
    expect(model.extras).toEqual(["[lints]\nname = 2024"]);
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

  it("refuses a dest that walks up out of the roots (issue #16)", () => {
    // Before the guard this returned "C:\SG\DCS\..\..\Windows\System32\evil.dll",
    // which Windows normalises to C:\Windows\System32\evil.dll — a mod picking
    // its own install location.
    expect(resolveDest("{SavedGames}/../../Windows/System32/evil.dll", roots)).toBeNull();
    expect(resolveDest("{GameInstall}/../../Windows/System32/evil.dll", roots)).toBeNull();
  });

  it("refuses an NTFS alternate-data-stream dest", () => {
    expect(resolveDest("{SavedGames}/notes.txt:hidden", roots)).toBeNull();
  });

  it("refuses before consulting either root, so the refusal never depends on settings", () => {
    // {GameInstall} unconfigured AND escaping: still null, and destStaysUnder is
    // what tells the two apart for the caller.
    expect(resolveDest("{GameInstall}/../x", { savedGames: "C:\\SG\\DCS" })).toBeNull();
    expect(destStaysUnder("{GameInstall}/../x")).toBe(false);
    expect(destStaysUnder("{GameInstall}/Mods/x")).toBe(true);
  });
});

describe("staysUnder (webview copy)", () => {
  // The predicate the browser gets. Its behaviour is specified once, in
  // src/core/domain/pathContainment.ts, and the cases come from the table all
  // three implementations of the rule are held to — so this asserts the copy
  // agrees rather than re-litigating (or quietly under-covering) the rules.
  const CASES = ALL_CONTAINMENT_PATHS;

  it("gives the same verdict as the domain predicate for every case", () => {
    for (const c of CASES) {
      expect([c, staysUnder(c)]).toEqual([c, domainStaysUnder(c)]);
    }
  });

  it("agrees with the domain predicate about manifest dests too", () => {
    for (const c of CASES) {
      // Both separators after the token, not just `/`. Synthesising these with
      // a forward slash only was why both copies agreed on the wrong answer:
      // each stripped `^\/`, so a native `{SavedGames}\Scripts\a.lua` kept its
      // backslash, read as rooted, and was refused.
      for (const token of ["", "{SavedGames}/", "{GameInstall}/", "{SavedGames}\\"]) {
        const dest = token + c;
        expect([dest, destStaysUnder(dest)]).toEqual([dest, domainDestStaysUnder(dest)]);
      }
    }
  });

  it.each(CONTAINMENT_CASES.dest)("reduces $dest to $relative like the domain copy — $why", ({
    dest,
    relative,
  }) => {
    // splitDest is the webview's destRelative: same token rule, and the same
    // separator strip. The form shows the author where a link will land, so a
    // disagreement here is the form promising a path the installer refuses.
    expect(splitDest(dest).rest).toBe(relative);
    expect(destStaysUnder(dest)).toBe(domainDestStaysUnder(dest));
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
