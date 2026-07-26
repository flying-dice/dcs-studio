#!/usr/bin/env node
// Runs the e2e layer with V8 coverage collection, then merges the per-test raw
// dumps into one Istanbul map and gates it — the e2e equivalent of the two
// vitest layers' `--coverage` thresholds.
//
// The measured set is the webview scripts the browser actually executes:
// media/*.js minus the *-core.js pair, which are framework-free modules the
// extension also loads directly and which the unit layer already owns. Keeping
// the three include sets disjoint is what makes each layer's percentage
// meaningful on its own.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import v8toIstanbul from "v8-to-istanbul";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const outDir = join(root, "coverage", "e2e");
const rawDir = join(outDir, "raw");
const mediaDir = join(root, "media");

/** Webview scripts the e2e layer is accountable for. */
function measuredFiles() {
  return readdirSync(mediaDir)
    .filter((f) => f.endsWith(".js") && !f.endsWith("-core.js"))
    .map((f) => join(mediaDir, f));
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const run = spawnSync("npx", ["playwright", "test"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, E2E_COVERAGE: "1" },
  shell: process.platform === "win32",
});
if (run.status !== 0) process.exit(run.status ?? 1);

// ── merge every raw dump into one Istanbul coverage map ──
const map = libCoverage.createCoverageMap({});
const seen = new Map(); // absolute path -> source text

const gated = new Set(measuredFiles());

for (const file of readdirSync(rawDir)) {
  if (!file.endsWith(".json")) continue;
  const entries = JSON.parse(readFileSync(join(rawDir, file), "utf8"));
  for (const entry of entries) {
    const name = basename(new URL(entry.url).pathname);
    const abs = join(mediaDir, name);
    // Only the gated set is merged: the *-core.js modules also load in these
    // pages, but the unit layer owns them and reporting them here would blur
    // which layer is accountable for the number.
    if (!existsSync(abs) || !gated.has(abs)) continue;
    if (!seen.has(abs)) seen.set(abs, entry.source ?? readFileSync(abs, "utf8"));
    const converter = v8toIstanbul(abs, 0, { source: seen.get(abs) });
    await converter.load();
    converter.applyCoverage(entry.functions);
    map.merge(converter.toIstanbul());
    converter.destroy();
  }
}

// Files that never executed at all still have to appear, or a webview with no
// harness would read as "not measured" instead of "0%".
for (const abs of measuredFiles()) {
  if (map.files().includes(abs)) continue;
  const source = readFileSync(abs, "utf8");
  const converter = v8toIstanbul(abs, 0, { source });
  await converter.load();
  // Applying an empty range list yields an EMPTY map, which summarises as
  // 100% — a webview with no harness would silently pass the gate. Apply one
  // whole-file range at count 0 instead, so "never loaded" reads as 0%.
  converter.applyCoverage([
    {
      functionName: "",
      isBlockCoverage: false,
      ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }],
    },
  ]);
  map.merge(converter.toIstanbul());
  converter.destroy();
}

const context = libReport.createContext({ dir: outDir, coverageMap: map });
reports.create("text").execute(context);
reports.create("html").execute(context);
reports.create("json-summary").execute(context);

// ── gate: 100% per file, same shape as the two vitest layers ──
const METRICS = ["lines", "functions", "statements", "branches"];
const failures = [];
for (const abs of measuredFiles()) {
  const summary = map.fileCoverageFor(abs).toSummary();
  for (const metric of METRICS) {
    const pct = summary[metric].pct;
    // An empty metric (no branches in the file) reports as 100 in Istanbul
    // when total is 0 — treat that as satisfied rather than as a gap.
    const total = summary[metric].total;
    if (total > 0 && pct < 100) {
      failures.push(`${basename(abs)}: ${metric} ${pct}% (${summary[metric].covered}/${total})`);
    }
  }
}

if (failures.length) {
  console.error(
    `\nE2E coverage gate failed — 100% required per file:\n  ${failures.join("\n  ")}\n`,
  );
  process.exit(1);
}
console.log(`\nE2E coverage gate passed: 100% across ${measuredFiles().length} webview scripts.`);
