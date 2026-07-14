import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// Enforces the hexagonal dependency rule from ARCHITECTURE.md: `src/core/**` may
// import only other core modules and `path`/`node:path`. Anything else — `vscode`,
// Node I/O builtins, or `src/adapters` — is a boundary violation. Also: core is
// TypeScript-only (no compiled `.js` leaking in).

const CORE_DIR = path.resolve(process.cwd(), "src", "core");

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
