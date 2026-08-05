#!/usr/bin/env node
/**
 * Mutation testing, codified.
 *
 * The repo's board journals are full of hand-run mutation evidence — "breaking
 * X failed exactly test Y" — recorded once by whoever wrote the code and then
 * lost to the next refactor. This script is that practice made repeatable: a
 * table of deliberate breakages, each with the gate that must NOTICE it.
 *
 * For each entry: copy the file aside, apply an EXACT string replacement, run
 * the named gate, and demand a non-zero exit. A gate that stays green is a
 * SURVIVED — a hole in the suite, reported loudly. A `find` that no longer
 * matches the file is a ROTTED — reported just as loudly, because a mutation
 * that cannot be applied is not a passing mutation, it is a dead one. The file
 * is always restored from the copy, in a `finally` and on every fatal signal.
 *
 * Never `git checkout` — a restore that reaches for git is a restore that can
 * take the rest of the working tree with it (the hazard card 14's `newproject`
 * entry records). The copy aside is the only source of truth for the restore,
 * and the run refuses to start if any target file is already dirty, so a crash
 * mid-run can never be confused with an edit in progress.
 *
 * Usage:
 *   node scripts/mutate.mjs            # every mutation
 *   node scripts/mutate.mjs --only <id>  # one (repeatable)
 *   node scripts/mutate.mjs --list       # the table, no runs
 *   node scripts/mutate.mjs --no-baseline # skip the green-first check
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Gate commands, named once so several mutations can share a baseline run.
 *
 * Every gate is SCOPED to the files that witness the mutation rather than being
 * a whole layer. Two reasons: a full layer takes minutes per mutation, and — the
 * one that actually matters — `npm run test:integration` has pre-existing
 * platform failures on a Windows box without the create-symlink privilege, so a
 * whole-layer gate would report every mutation KILLED without ever running the
 * mutated code. A scoped gate that must be GREEN before the mutation is applied
 * is the only kind whose red is evidence.
 */
const GATES = {
  unitContract: "npx vitest run -c vitest.unit.config.ts test/unit/core/webviewContract.test.ts",
  unitNav:
    "npx vitest run -c vitest.unit.config.ts test/unit/nav/navPresenter.test.ts test/unit/core/webviewContract.test.ts",
  unitPublish: "npx vitest run -c vitest.unit.config.ts test/unit/publish/publishPresenter.test.ts",
  unitDocs: "npx vitest run -c vitest.unit.config.ts test/unit/docs/docsPresenter.test.ts",
  integrationPanel:
    "npx vitest run -c vitest.integration.config.ts test/integration/webview/panel.test.ts",
  integrationManifestForm:
    "npx vitest run -c vitest.integration.config.ts test/integration/manifest/formPanel.test.ts",
  unitPublishService:
    "npx vitest run -c vitest.unit.config.ts test/unit/publish/publishService.test.ts",
  unitDap: "npx vitest run -c vitest.unit.config.ts test/unit/debug/dapTranslation.test.ts",
  // Both files, because the rule they share is the point: the packager's list
  // and the form's preview must answer alike, so a mutation only one of them
  // notices is a mutation that has found the two drifting apart.
  unitBundlePlan:
    "npx vitest run -c vitest.unit.config.ts test/unit/core/bundlePlan.test.ts test/unit/core/bundlePreviewService.test.ts",
  unitManifestPresenter:
    "npx vitest run -c vitest.unit.config.ts test/unit/manifest/manifestPresenter.test.ts",
  integrationPublishPanel:
    "npx vitest run -c vitest.integration.config.ts test/integration/publish/publishPanel.test.ts",
  integrationErrors:
    "npx vitest run -c vitest.integration.config.ts test/integration/webview/htmlAndErrors.test.ts",
  integrationPackaging:
    "npx vitest run -c vitest.integration.config.ts test/integration/architecture/packaging.test.ts",
  e2eNewProject: "npx playwright test tests/newproject.spec.ts tests/webviewContract.spec.ts",
  cargoServer:
    "cargo test --manifest-path bridge/Cargo.toml -p dcs-bridge-core --lib -- jsonrpc::server::tests jsonrpc::teardown::tests",
  cargoEvalGuard:
    "cargo test --manifest-path bridge/Cargo.toml -p dcs-bridge-core --test eval_guard -- --include-ignored",
  cargoDebugEngine:
    "cargo test --manifest-path bridge/Cargo.toml -p dcs-bridge-core --test debug_engine_safety -- --include-ignored a_pump_that_raises",
};

/**
 * Gates that load DCS's `lua.dll` at runtime. Without it on PATH the cargo
 * process fails to start at all — which would look exactly like a KILLED
 * mutation while proving nothing. Entries needing it are SKIPPED with the
 * reason rather than counted, so a box without DCS installed gets an honest
 * partial run instead of a fraudulent green one.
 */
const NEEDS_LUA_DLL = new Set(["cargoEvalGuard", "cargoDebugEngine"]);

/**
 * The table. Each `find` is anchored on a line distinctive enough that a
 * reformat is unlikely to move it — a decision's own words, not its
 * punctuation. `expectFailIn` is the gate that must go red.
 */
const MUTATIONS = [
  {
    id: "panel-drain",
    file: "src/webview/panel.ts",
    note: "card 07 — disposeWithPanel's drain loop: every panel's listeners leak without it",
    find: "      while (disposables.length) disposables.pop()?.dispose();",
    replace: "      // MUTANT: the bag is never drained",
    expectFailIn: "integrationPanel",
  },
  {
    id: "manifest-map-delete",
    file: "src/manifest/formPanel.ts",
    note: "card 07's 22-failure anchor — a form left in the map is revealed instead of re-opened",
    find: "      ManifestFormPanel.panels.delete(this.document.uri.toString());",
    replace: "      // MUTANT: the closed form keeps its slot in the map",
    expectFailIn: "integrationManifestForm",
  },
  {
    id: "manifest-protocol-empty",
    file: "src/core/app/webviewContract.ts",
    note: "card 09/14 — the declared message table emptied: the census must not be silently erasable",
    find: [
      "  toHost: Object.keys(MANIFEST_TO_HOST_KEYS),",
      "  toWebview: Object.keys(MANIFEST_TO_WEBVIEW_KEYS),",
    ].join("\n"),
    replace: ["  toHost: [],", "  toWebview: [],"].join("\n"),
    expectFailIn: "unitContract",
  },
  {
    id: "publish-busy-finally",
    file: "src/core/app/publishPresenter.ts",
    note: "card 14 — the busy bracket's finally: without it a failure leaves the button latched forever",
    find: [
      "    try {",
      "      await fn();",
      "    } catch (e) {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text being matched, not a template literal — the placeholder belongs to the file
      "      this.log(`✖ ${errorText(e)}`);",
      "    } finally {",
      '      this.deps.post({ type: "busy", scope, busy: false });',
      "    }",
    ].join("\n"),
    replace: [
      "    // MUTANT: the latch clears on the success path only",
      "    await fn();",
      '    this.deps.post({ type: "busy", scope, busy: false });',
    ].join("\n"),
    expectFailIn: "unitPublish",
  },
  {
    id: "nav-ready-case",
    file: "src/core/app/navPresenter.ts",
    note: "card 29 — the nav boot handshake: without the reply the sidebar's opening pushes are lost",
    find: ['      case "ready":', "        await this.ready();", "        break;"].join("\n"),
    replace: [
      '      case "ready":',
      "        // MUTANT: the handshake goes unanswered",
      "        break;",
    ].join("\n"),
    expectFailIn: "unitNav",
  },
  {
    id: "newproject-ready-post",
    file: "media/newproject.js",
    note: "card 24 — New Project's boot handshake: a lost constructor push leaves a blank page forever",
    find: '  vscode.postMessage({ type: "ready" });',
    replace: "  // MUTANT: the page never announces itself",
    expectFailIn: "e2eNewProject",
  },
  {
    id: "docs-navigate-guard",
    file: "src/core/app/docsPresenter.ts",
    note: "card 28 — revealing the manual with no page named must leave the reader where they were",
    find: "    if (!page) return;",
    replace: "    // MUTANT: every reveal yanks the reader to a page",
    expectFailIn: "unitDocs",
  },
  {
    id: "poster-disposed-latch",
    file: "src/webview/panel.ts",
    note: "sprint — webviewPoster's disposed latch: a presenter resolving after close must post into silence, not a throw",
    find: "    if (!disposed) void panel.webview.postMessage(msg);",
    replace: "    void panel.webview.postMessage(msg); // MUTANT: posts outlive the panel",
    expectFailIn: "integrationPublishPanel",
  },
  {
    id: "publish-facts-single-pass",
    file: "src/core/app/publishService.ts",
    note: "card 34 — toolFacts makes ONE gh probe pass; a cold gh --version is 9.8s and auth status hits the network",
    find: "      gh.facts(),",
    replace:
      "      gh.facts().then(async (f) => (await gh.facts(), f)), // MUTANT: the probe pass runs twice",
    expectFailIn: "unitPublishService",
  },
  {
    id: "dap-fastpath-snapshot",
    file: "src/core/domain/dapTranslation.ts",
    note: "card 39 — a live pause snapshot hands the outcome to the poll loop; finishing anyway tears down a paused session",
    find: "  if (hasSnapshot) return { finish: false };",
    replace: "  // MUTANT: the fast path finishes even mid-pause",
    expectFailIn: "unitDap",
  },
  {
    id: "errors-stack-cap",
    file: "src/errors.ts",
    note: "card 35 — the stack cap chooses truncation only OVER the limit; a short stack must go into the issue whole",
    find: "      error.stack.length > MAX_STACK_CHARS",
    replace: "      error.stack.length > 0 // MUTANT: every stack truncates",
    expectFailIn: "integrationErrors",
  },
  {
    id: "trust-declaration",
    file: "package.json",
    note: "card 38 — untrustedWorkspaces: VS Code's default for an undeclared extension is to run it untrusted",
    find: '      "supported": false,',
    replace: '      "supported": true,',
    expectFailIn: "integrationPackaging",
  },
  {
    id: "bundle-blank-path",
    file: "src/core/domain/bundlePlan.ts",
    note: "card 44 — a blank [[bundle]] path joins to the PROJECT ROOT, so packing it puts the whole working tree, .git included, in a public release",
    find: "    if (!path || seen.has(path)) continue;",
    replace: "    if (seen.has(path)) continue; // MUTANT: a blank row is an entry",
    expectFailIn: "unitBundlePlan",
  },
  {
    id: "bundle-preview-generation",
    file: "src/core/app/manifestPresenter.ts",
    note: "card 44 — without the generation drop the form can settle on the answer to a question the user already changed, and nothing on screen says it is stale",
    find: "    if (generation !== this.previewGeneration) return;",
    replace: "    void generation; // MUTANT: a superseded answer still wins",
    expectFailIn: "unitManifestPresenter",
  },
  {
    id: "rust-drop-stops-server",
    file: "bridge/crates/bridge-core/src/jsonrpc/server.rs",
    note: "card 18 iteration 3 — the collected server must stop itself; DCS crashes on mission unload if it does not",
    find: "            match self.stop(COLLECTED_STOP) {",
    replace: "            match None::<ServerStop> { // MUTANT: the GC path stops nothing",
    expectFailIn: "cargoServer",
  },
  {
    id: "lua-rt-fatal-guard",
    file: "bridge/crates/bridge-core/lua/rt.lua",
    note: "sprint — rt.lua's guarded DCS view: the process-killing getters must be replaced, not merely documented",
    find: "    for name, why in pairs(FATAL_DCS) do",
    replace: "    for name, why in pairs({}) do -- MUTANT: nothing is guarded",
    expectFailIn: "cargoEvalGuard",
  },
  {
    id: "lua-pump-pcall",
    file: "bridge/crates/bridge-core/lua/debug_engine.lua",
    note: "sprint — DBG.pump is best-effort: a raising RPC drain must cost one drain, not the debug session",
    find: "    local ok, err = pcall(D.pump)",
    replace:
      "    local ok, err = true, nil; D.pump() -- MUTANT: the drain can take the session down",
    expectFailIn: "cargoDebugEngine",
  },
];

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const only = [];
let list = false;
let baseline = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--only") only.push(argv[++i]);
  else if (a === "--list") list = true;
  else if (a === "--no-baseline") baseline = false;
  else if (a === "-h" || a === "--help") {
    console.log("usage: node scripts/mutate.mjs [--only <id>]... [--list] [--no-baseline]");
    process.exit(0);
  } else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

const C = process.stdout.isTTY
  ? {
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      dim: "\x1b[2m",
      bold: "\x1b[1m",
      off: "\x1b[0m",
    }
  : { red: "", green: "", yellow: "", dim: "", bold: "", off: "" };

if (list) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(24)} ${m.file}  →  ${m.expectFailIn}`);
  process.exit(0);
}

const selected = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;
const unknown = only.filter((id) => !MUTATIONS.some((m) => m.id === id));
if (unknown.length) {
  console.error(`no such mutation id: ${unknown.join(", ")}`);
  process.exit(2);
}

/** Is `lua.dll` reachable on PATH? The cargo gates that embed Lua need it. */
function luaDllOnPath() {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      return fs.existsSync(path.join(d, "lua.dll")) || fs.existsSync(path.join(d, "liblua5.1.so"));
    } catch {
      return false;
    }
  });
}
const hasLuaDll = process.platform === "win32" ? luaDllOnPath() : true;
const LUA_SKIP =
  "DCS's lua.dll is not on PATH — put <DCS>\\bin on PATH to run the Lua-embedding gates";

function run(cmd) {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, stdio: "inherit" });
  if (r.error) return 127;
  return r.status ?? 1;
}

/** Refuse to start against a dirty target: a restore must not overwrite real work. */
function assertClean(files) {
  const r = spawnSync("git", ["status", "--porcelain", "--", ...files], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`${C.red}could not read git status; refusing to mutate${C.off}`);
    process.exit(2);
  }
  const dirty = r.stdout.trim();
  if (dirty) {
    console.error(
      `${C.red}refusing to start: these target files already have uncommitted changes${C.off}`,
    );
    console.error(dirty);
    console.error("commit or stash them first — the restore would overwrite them.");
    process.exit(2);
  }
}

// Crash safety. `active` holds the one file currently swapped out; any fatal
// exit path puts it back before leaving.
let active = null;
function restoreActive() {
  if (!active) return;
  try {
    fs.copyFileSync(active.backup, active.abs);
    // Bump the mtime clear of the artifacts just built FROM the mutant. Cargo
    // fingerprints `include_str!` inputs by mtime and treats "not newer than the
    // output" as fresh — and the restore lands within the same tick as the test
    // binary it must invalidate. Without this the NEXT run compiles nothing and
    // greets you with a red baseline on untouched source: a stale mutant, silently
    // still in the binary. A couple of seconds ahead is enough and costs nothing.
    const ahead = new Date(Date.now() + 2000);
    fs.utimesSync(active.abs, ahead, ahead);
    fs.rmSync(active.backup, { force: true });
    console.error(`${C.yellow}restored ${active.rel} from the copy aside${C.off}`);
  } catch (e) {
    console.error(
      `${C.red}COULD NOT RESTORE ${active.rel} — copy is at ${active.backup}${C.off}`,
      e,
    );
  }
  active = null;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => {
    restoreActive();
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  restoreActive();
  console.error(e);
  process.exit(1);
});
process.on("exit", restoreActive);

const targets = [...new Set(selected.map((m) => m.file))];
assertClean(targets);

const results = [];

// Baselines: a gate that is already red cannot testify that a mutation broke
// anything. Each distinct gate that will actually be used runs once, clean.
const wanted = [...new Set(selected.map((m) => m.expectFailIn))];
const baselineOf = new Map();
if (baseline) {
  for (const g of wanted) {
    if (NEEDS_LUA_DLL.has(g) && !hasLuaDll) {
      baselineOf.set(g, "skipped");
      continue;
    }
    console.log(`\n${C.bold}── baseline ${g}${C.off}\n${C.dim}${GATES[g]}${C.off}`);
    const code = run(GATES[g]);
    baselineOf.set(g, code === 0 ? "green" : "red");
    if (code !== 0)
      console.error(`${C.red}baseline RED for ${g} — its mutations cannot be judged${C.off}`);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-mutate-"));

for (const m of selected) {
  const abs = path.join(ROOT, m.file);
  const gateCmd = GATES[m.expectFailIn];
  console.log(`\n${C.bold}── ${m.id}${C.off}  ${C.dim}${m.file} → ${m.expectFailIn}${C.off}`);
  console.log(`${C.dim}   ${m.note}${C.off}`);

  if (!gateCmd) {
    results.push({ id: m.id, gate: m.expectFailIn, status: "ERROR", detail: "unknown gate" });
    continue;
  }
  if (NEEDS_LUA_DLL.has(m.expectFailIn) && !hasLuaDll) {
    console.log(`${C.yellow}   SKIPPED — ${LUA_SKIP}${C.off}`);
    results.push({ id: m.id, gate: m.expectFailIn, status: "SKIPPED", detail: LUA_SKIP });
    continue;
  }
  if (baseline && baselineOf.get(m.expectFailIn) === "red") {
    results.push({
      id: m.id,
      gate: m.expectFailIn,
      status: "ERROR",
      detail: "gate red before mutating",
    });
    continue;
  }

  const original = fs.readFileSync(abs, "utf8");
  const first = original.indexOf(m.find);
  if (first === -1) {
    // LOUD, and never a silent pass: the code moved out from under the table.
    console.error(`${C.red}   MUTATION ROTTED — the find string is no longer in ${m.file}${C.off}`);
    console.error(
      `${C.dim}   looked for:\n${m.find
        .split("\n")
        .map((l) => `     ${l}`)
        .join("\n")}${C.off}`,
    );
    results.push({
      id: m.id,
      gate: m.expectFailIn,
      status: "ROTTED",
      detail: "find string not found",
    });
    continue;
  }
  if (original.indexOf(m.find, first + 1) !== -1) {
    console.error(`${C.red}   MUTATION ROTTED — the find string is AMBIGUOUS in ${m.file}${C.off}`);
    results.push({
      id: m.id,
      gate: m.expectFailIn,
      status: "ROTTED",
      detail: "find string matched twice",
    });
    continue;
  }

  const backup = path.join(tmpDir, `${m.id}${path.extname(m.file)}.orig`);
  fs.writeFileSync(backup, original);
  active = { abs, backup, rel: m.file };
  let code;
  try {
    fs.writeFileSync(abs, original.replace(m.find, m.replace));
    console.log(`${C.dim}   ${gateCmd}${C.off}`);
    code = run(gateCmd);
  } finally {
    restoreActive();
  }

  if (code !== 0) {
    console.log(`${C.green}   KILLED — ${m.expectFailIn} exited ${code}${C.off}`);
    results.push({ id: m.id, gate: m.expectFailIn, status: "KILLED", detail: `exit ${code}` });
  } else {
    console.error(
      `${C.red}   SURVIVED — ${m.expectFailIn} stayed green with the mutation applied${C.off}`,
    );
    results.push({ id: m.id, gate: m.expectFailIn, status: "SURVIVED", detail: "gate exit 0" });
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

// Summary.
const w = (rows, key) => Math.max(key.length, ...rows.map((r) => String(r[key]).length));
const cols = [
  ["id", w(results, "id")],
  ["gate", w(results, "gate")],
  ["status", w(results, "status")],
  ["detail", w(results, "detail")],
];
const line = (cells) => `| ${cells.map(([v, n]) => String(v).padEnd(n)).join(" | ")} |`;
console.log(`\n${C.bold}Mutation summary${C.off}`);
console.log(line(cols.map(([k, n]) => [k, n])));
console.log(`|${cols.map(([, n]) => "-".repeat(n + 2)).join("|")}|`);
for (const r of results) {
  const colour =
    r.status === "KILLED"
      ? C.green
      : r.status === "SKIPPED"
        ? C.yellow
        : r.status === "ERROR"
          ? C.red
          : C.red;
  console.log(colour + line(cols.map(([k, n]) => [r[k], n])) + C.off);
}

const killed = results.filter((r) => r.status === "KILLED").length;
const skipped = results.filter((r) => r.status === "SKIPPED").length;
const bad = results.filter((r) => r.status !== "KILLED" && r.status !== "SKIPPED");
console.log(
  `\n${killed} killed, ${skipped} skipped, ${bad.length} not killed (of ${results.length}).`,
);
process.exit(bad.length ? 1 : 0);
