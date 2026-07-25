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
 * Crossings that already existed when this half of the rule was written. It is
 * a ratchet, not a licence: a new crossing fails the check, and this list must
 * shrink to empty — delete each entry as its site is fixed. Only the first is
 * tracked by an issue (#40 — MyModsPanel names the concrete JsonLedgerStore
 * rather than the SubscriptionLedgerStore port it actually needs); the rest are
 * the same defect, surfaced by writing this check, and have no issue yet.
 *
 * Deliberately not asserted to be exhaustive: a fix landing elsewhere would
 * then fail this test, and "someone repaired a boundary" must never read as a
 * boundary violation.
 */
const KNOWN_CROSSINGS = new Set([
  "src/install/myModsPanel.ts -> src/adapters/node/jsonLedgerStore",
  "src/install/myModsPanel.ts -> src/adapters/node/processLauncher",
  "src/adapters/vscode/installRoots.ts -> src/bridge/paths",
  "src/adapters/vscode/installRoots.ts -> src/install/dataDir",
  "src/bridge/client.ts -> src/adapters/node/wsTransport",
  "src/debug/adapter.ts -> src/adapters/node/scheduler",
  "src/debug/adapter.ts -> src/bridge/client",
  "src/debug/adapter.ts -> src/bridge/clients",
  "src/debug/adapter.ts -> src/mission/missionPanel",
  "src/debug/factory.ts -> src/adapters/node/scheduler",
  "src/debug/factory.ts -> src/bridge/client",
  "src/debug/factory.ts -> src/bridge/clients",
  // `bridge/paths` is imported by three unrelated features: it is a shared
  // module wearing a feature's clothes, and the fix is to move it, not to widen
  // the rule for it.
  "src/log/logPanel.ts -> src/bridge/paths",
  "src/manifest/formPanel.ts -> src/bridge/paths",
  "src/mission/missionPanel.ts -> src/bridge/paths",
  "src/nav/navView.ts -> src/bridge/clients",
  "src/nav/navView.ts -> src/skills/library",
  "src/publish/preflight.ts -> src/adapters/vscode/manifest",
  "src/setup/panel.ts -> src/adapters/node/sevenZip",
]);

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
