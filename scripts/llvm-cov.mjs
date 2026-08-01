#!/usr/bin/env node
// `cargo llvm-cov` behind an exclusive lock.
//
// Two concurrent llvm-cov runs share bridge/target/llvm-cov-target, and the
// second's rebuild deletes the first's test binaries. The first then dies with
// `could not execute process … (never executed)` on whichever test happens to
// be late in its run order — which looks exactly like a flaky test, is not one,
// and has cost real time to re-diagnose. Cargo's own file lock does not cover
// it: both processes are legitimately building, just into each other.
//
// The rule "never run two at once" has lived in
// docs/02-guides/01-running-the-tests.md, where nothing enforced it and two
// agents (or a developer and a watch task) could not see each other's runs at
// all. This makes it mechanical: the second run fails immediately, with the
// explanation, instead of corrupting the first ten minutes in.
//
// Usage — anything after the script is passed straight to `cargo llvm-cov`:
//
//   node scripts/llvm-cov.mjs --workspace --fail-under-lines 100
//
// The escape hatch is the one the guide already names: a run with its own
// `--target-dir` does not share the artefacts, so it does not contend. Pass it
// and the lock moves with it, so two such runs are free to proceed in parallel.
//
//   node scripts/llvm-cov.mjs --workspace --target-dir target/llvm-cov-second
//
// DCS_LLVM_COV_DRY_RUN=<ms> takes and holds the lock for <ms> without running
// cargo at all. It exists to test this script's locking without spending a
// full coverage build, and is why the contention path can be exercised.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const bridge = join(root, "bridge");
const args = process.argv.slice(2);

/**
 * The lock guards a target directory, not the machine — that is what the
 * `--target-dir` escape hatch means. So the lock lives in whichever directory
 * this run is about to build into.
 */
function targetDir() {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-dir" && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith("--target-dir=")) return args[i].slice("--target-dir=".length);
  }
  return "target";
}

const dir = targetDir();
const lockDir = isAbsolute(dir) ? dir : join(bridge, dir);
const lockPath = join(lockDir, ".llvm-cov.lock");

mkdirSync(lockDir, { recursive: true });

let fd;
try {
  // `wx` is the atomic part: create-or-fail, so two processes racing here
  // cannot both win, however close together they arrive.
  fd = openSync(lockPath, "wx");
} catch (err) {
  if (err.code !== "EEXIST") throw err;
  refuse();
}

writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
closeSync(fd);

let released = false;
function release() {
  if (released) return;
  released = true;
  rmSync(lockPath, { force: true });
}

// Every way out has to drop the lock, or the next run inherits a stale one and
// the mechanism becomes the problem it was added to solve. `exit` covers normal
// returns and process.exit; the signals do not fire `exit` on their own.
process.on("exit", release);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    release();
    process.exit(1);
  });
}

const dryRunMs = Number(process.env.DCS_LLVM_COV_DRY_RUN ?? 0);
if (dryRunMs > 0) {
  console.log(`[llvm-cov lock] held ${lockPath} for ${dryRunMs}ms (dry run)`);
  console.log(`[llvm-cov lock] would run: cargo llvm-cov ${args.join(" ")}`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, dryRunMs);
  process.exit(0);
}

const run = spawnSync("cargo", ["llvm-cov", ...args], {
  cwd: bridge,
  stdio: "inherit",
  shell: process.platform === "win32",
});
release();
if (run.error) {
  console.error(`\nCould not run cargo llvm-cov: ${run.error.message}\n`);
  process.exit(1);
}
process.exit(run.status ?? 1);

function refuse() {
  const held = readHolder();
  const alive = held.pid !== undefined && isRunning(held.pid);
  console.error(
    [
      "",
      `Another cargo llvm-cov run holds ${lockPath}.`,
      held.pid === undefined
        ? "  (the lock file names no pid)"
        : `  held by pid ${held.pid}${held.since ? ` since ${held.since}` : ""} — ${
            alive ? "that process is still running" : "that process is GONE, so this lock is stale"
          }`,
      "",
      "Two runs share the llvm-cov target directory, and the second's rebuild",
      "deletes the first's test binaries. The first then fails with",
      "`could not execute process … (never executed)` on some unrelated test,",
      "which reads as flakiness and is not. Refusing is cheaper than debugging",
      "that a second time.",
      "",
      alive
        ? "Wait for it to finish, or give this run its own target directory:\n" +
          "  node scripts/llvm-cov.mjs --workspace --target-dir target/llvm-cov-second"
        : `Delete the stale lock and re-run:\n  rm ${lockPath}`,
      "",
      "See docs/02-guides/01-running-the-tests.md.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function readHolder() {
  try {
    const [pid, since] = readFileSync(lockPath, "utf8").split("\n");
    const parsed = Number(pid);
    return { pid: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined, since };
  } catch {
    return {};
  }
}

/** Signal 0 checks for existence without delivering anything. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still running.
    return err.code === "EPERM";
  }
}
