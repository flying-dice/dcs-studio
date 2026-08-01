import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// What ships in the .vsix, as opposed to what is in `src/`.
//
// `tsc` never deletes: it emits into `outDir` and leaves everything already
// there untouched. A source file that is renamed, moved or deleted therefore
// keeps its compiled `.js` in `out/` indefinitely, and `.vscodeignore` excludes
// `src/**` but not `out/**` — so `vsce package` picks the orphan up and users
// install it.
//
// This is not hypothetical tidiness. `out/adapters/mock/marketplace.js` was
// being packaged: the mock marketplace ARCHITECTURE.md says cannot reach a
// shipped build. The statement was true of the sources and false of the
// artefact, and nothing in the build could tell the difference.
//
// Two things are checked, because either alone can pass while the defect is
// back: that the wipe still runs as part of `compile` (and so of
// `vscode:prepublish`), and that `out/` as it actually stands right now
// partitions cleanly onto `src/`.

const ROOT = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT, "src");
const OUT_DIR = path.join(ROOT, "out");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The `src/` file an emitted artefact came from, e.g. `out/a/b.js.map` -> `src/a/b.ts`. */
function sourceOf(emitted: string): string {
  const rel = path.relative(OUT_DIR, emitted);
  const stem = rel.replace(/\.js(\.map)?$/, "");
  return path.join(SRC_DIR, `${stem}.ts`);
}

describe("the compiled output directory", () => {
  // `compile` is what `vscode:prepublish` runs, so wiring the wipe there is
  // what makes `vsce package` safe. Asserting on the script text rather than
  // on behaviour is deliberate: the behavioural half is covered below, and
  // this half catches the specific regression of someone shortening `compile`
  // back to a bare `tsc` — which no output check could notice on a clean
  // checkout, because a clean checkout has no orphans to find.
  it("is wiped by the compile script, which prepublish runs", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.clean).toContain("scripts/clean-out.mjs");
    expect(pkg.scripts.compile).toContain("npm run clean");
    expect(pkg.scripts.compile).toContain("tsc -p ./");
    expect(pkg.scripts["vscode:prepublish"]).toContain("npm run compile");
  });

  // The behavioural half. Driven against a scratch directory rather than the
  // real `out/`, so it neither depends on nor destroys the build the rest of
  // this suite reads.
  it("actually loses a stale artefact when the wipe runs", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-clean-"));
    const orphan = path.join(scratch, "adapters", "mock", "marketplace.js");
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, "// a source that no longer exists\n");
    expect(fs.existsSync(orphan)).toBe(true);

    execFileSync(process.execPath, [path.join(ROOT, "scripts", "clean-out.mjs"), scratch]);

    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("survives being asked to wipe a directory that is not there", () => {
    // First-ever build: `out/` does not exist yet and that is not an error.
    const absent = path.join(os.tmpdir(), `dcs-clean-absent-${process.pid}`);
    expect(fs.existsSync(absent)).toBe(false);
    expect(() =>
      execFileSync(process.execPath, [path.join(ROOT, "scripts", "clean-out.mjs"), absent]),
    ).not.toThrow();
  });

  // The direct assertion: everything in `out/` is accounted for by `src/`.
  //
  // This needs a build present, so CI's integration job compiles first. It is
  // NOT written to skip when `out/` is missing — a check that quietly passes
  // on the machine that has no artefacts is exactly how the orphans survived.
  describe("against the build in out/", () => {
    it("has a build to check", () => {
      expect(
        fs.existsSync(OUT_DIR),
        "out/ is missing — run `npm run compile` before the integration suite",
      ).toBe(true);
    });

    it("contains nothing that no longer has a source file", () => {
      const emitted = walk(OUT_DIR);
      // Guards the partition below against a walk that found nothing.
      expect(emitted.length).toBeGreaterThan(100);

      const orphans = emitted
        .filter((f) => !fs.existsSync(sourceOf(f)))
        .map((f) => path.relative(ROOT, f).replaceAll(path.sep, "/"));

      expect(
        orphans,
        `\nCompiled output with no src/ counterpart — these ship in the .vsix:\n${orphans.join("\n")}\n`,
      ).toEqual([]);
    });

    it("emits only the artefact kinds this rule knows how to trace", () => {
      // `sourceOf` maps `.js` and `.js.map` back to a `.ts`. If the compiler
      // config ever starts emitting something else (declarations, copied
      // assets, JSON), every one of those files would resolve to a source
      // path that does not exist and the partition above would fail loudly
      // rather than silently — but naming the expectation here says why.
      const kinds = new Set(
        walk(OUT_DIR).map((f) => (f.endsWith(".js.map") ? ".js.map" : path.extname(f))),
      );
      expect([...kinds].sort()).toEqual([".js", ".js.map"]);
    });
  });
});
