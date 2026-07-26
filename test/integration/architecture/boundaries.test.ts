import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Enforces both directions of the hexagonal dependency rule from ARCHITECTURE.md.
//
// Inward: `src/core/**` may import only other core modules and `path`/`node:path`.
// Anything else — `vscode`, Node I/O builtins, or `src/adapters` — is a boundary
// violation. Also: core is TypeScript-only (no compiled `.js` leaking in).
//
// Sideways: everything outside core is an adapter (the `<feature>/` directories
// are adapters that happen to live beside their one caller), and adapters reach
// core through ports and domain types — never into each other's internals. A
// panel that names another module's concrete class has bound itself to that
// implementation, which is exactly what the port existed to prevent.

const SRC_DIR = path.resolve(process.cwd(), "src");
const CORE_DIR = path.join(SRC_DIR, "core");

/** Node builtins core must never reach for (with/without the `node:` prefix). */
const FORBIDDEN_BUILTINS = new Set(
  [
    "vscode",
    "fs",
    "fs/promises",
    "child_process",
    "net",
    "http",
    "https",
    "os",
    "crypto",
    "stream",
    "stream/promises",
    "worker_threads",
  ].flatMap((m) => [m, `node:${m}`]),
);

const ALLOWED_BARE = new Set(["path", "node:path"]);

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Every import/export-from/require/dynamic-import specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec loop
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

function classify(file: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const resolved = path.resolve(path.dirname(file), spec);
    const rel = path.relative(CORE_DIR, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `relative import escapes src/core: "${spec}"`;
    }
    return null; // stays within core
  }
  if (ALLOWED_BARE.has(spec)) return null;
  if (FORBIDDEN_BUILTINS.has(spec)) return `forbidden module import: "${spec}"`;
  // A bare (third-party or other) import is not part of the pure core surface.
  return `disallowed non-core import: "${spec}"`;
}

// ── Sideways: adapters and features must not reach into each other ───────────

/**
 * The unit a module belongs to: its first path segment under `src/`, so
 * `src/adapters/node/fs.ts` is `adapters` and `src/errors.ts` is `errors.ts`.
 */
function unitOf(relToSrc: string): string {
  return relToSrc.split(path.sep)[0];
}

/** Cross-cutting modules every unit may import: no feature owns them. */
const SHARED = new Set(["errors.ts", "external.ts", "webview"]);

/**
 * `extension.ts` is the composition root — the one place that is *supposed* to
 * name every concrete adapter, because wiring them together is its whole job.
 */
const COMPOSITION_ROOT = "extension.ts";

/**
 * **Empty, and it stays empty.** This was a ratchet holding the 19 crossings
 * that existed when the check was written; all 19 are fixed (#40, #61), so the
 * rule is now enforced outright with nothing grandfathered.
 *
 * Kept as an empty set rather than deleted so a future crossing that genuinely
 * cannot be fixed today has somewhere to be recorded WITH its reason, instead
 * of the rule being weakened or the check deleted. Adding an entry should
 * require an issue number in a comment beside it.
 */
const KNOWN_CROSSINGS = new Set<string>([]);

/** The crossing `file` makes by importing `spec`, or null when it makes none. */
function crossing(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // vscode/node/third-party: not our rule
  const target = path.relative(SRC_DIR, path.resolve(path.dirname(file), spec));
  const from = path.relative(SRC_DIR, file);
  const toUnit = unitOf(target);
  if (toUnit === "core" || toUnit === unitOf(from)) return null;
  if (SHARED.has(toUnit) || SHARED.has(`${target}.ts`)) return null;
  return `src/${from} -> src/${target}`.replaceAll(path.sep, "/");
}

describe("adapter boundary", () => {
  it("no module outside core reaches into another unit's internals", () => {
    const files = walk(SRC_DIR, ".ts").filter(
      (f) => !f.startsWith(CORE_DIR + path.sep) && path.relative(SRC_DIR, f) !== COMPOSITION_ROOT,
    );
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        const problem = crossing(file, spec);
        if (problem && !KNOWN_CROSSINGS.has(problem)) violations.push(problem);
      }
    }
    expect(violations, `\n${violations.join("\n")}`).toEqual([]);
  });
});

describe("core boundary", () => {
  const tsFiles = fs.existsSync(CORE_DIR) ? walk(CORE_DIR, ".ts") : [];

  it("has core source to check", () => {
    expect(tsFiles.length).toBeGreaterThan(0);
  });

  it("src/core imports nothing outside the hexagon", () => {
    const violations: string[] = [];
    for (const file of tsFiles) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        const problem = classify(file, spec);
        if (problem) violations.push(`${path.relative(process.cwd(), file)}: ${problem}`);
      }
    }
    expect(violations, `\n${violations.join("\n")}`).toEqual([]);
  });

  it("src/core contains no compiled .js files", () => {
    const jsFiles = fs.existsSync(CORE_DIR) ? walk(CORE_DIR, ".js") : [];
    expect(jsFiles.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
