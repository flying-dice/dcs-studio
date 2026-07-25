import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";

// ProcessLauncher runs third-party mod executables on a user's machine and is
// the only thing tracking them afterwards. Its bookkeeping is what the My Mods
// panel shows as "running" and what Stop acts on, so the failure modes are
// user-visible and sticky: a key left in the map after the process died shows a
// dead mod as running and makes Stop a no-op forever; a key removed by a *stale*
// event from an already-replaced child does the reverse, orphaning a live
// process the panel can no longer stop.
//
// Real spawning cannot express those cases — you cannot ask a real process to
// deliver a late exit event for a handle you already replaced — so the process
// is faked while the exe-existence check runs against a real temp file, since
// that check is the guard against launching a path that a half-finished install
// never wrote.

let spawner: SpawnHarness;

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawn(cmd, args, opts),
}));

import { ProcessLauncher } from "../../../src/adapters/node/processLauncher";

let root: string;
let exe: string;
const PLATFORM = process.platform;

/** A plan the harness leaves live, so the test drives the child's lifecycle. */
const live = () => undefined;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  spawner = createSpawnHarness();
  spawner.plan(live);
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dcs-launch-"));
  exe = path.join(root, "mod.exe");
  nodeFs.writeFileSync(exe, "");
});

afterEach(() => {
  setPlatform(PLATFORM);
  vi.restoreAllMocks();
  nodeFs.rmSync(root, { recursive: true, force: true });
});

const plan = (over: Partial<{ exe: string; cwd: string; args: string[] }> = {}) => ({
  exe,
  cwd: root,
  args: ["--fullscreen"],
  ...over,
});

describe("launch", () => {
  it("spawns the entrypoint detached and starts tracking it", async () => {
    // Detached + unref is what lets the mod outlive the IDE, which is the
    // documented lifecycle policy — a tracked-but-attached child would be
    // killed when VS Code exits.
    const launcher = new ProcessLauncher();
    launcher.launch("me/mod::app", plan());

    expect(spawner.calls[0]).toEqual({
      cmd: exe,
      args: ["--fullscreen"],
      opts: { cwd: root, detached: true, stdio: "ignore" },
    });
    expect(spawner.children[0].unrefCount).toBe(1);
    expect(launcher.isRunning("me/mod::app")).toBe(true);
    expect(launcher.runningKeys()).toEqual(["me/mod::app"]);
  });

  it("refuses to launch an executable that is not on disk", () => {
    // A partially-extracted or hand-deleted install would otherwise surface as
    // an opaque spawn error long after the click.
    const missing = path.join(root, "gone.exe");
    expect(() => new ProcessLauncher().launch("k", plan({ exe: missing }))).toThrow(
      `Executable not found: ${missing}`,
    );
    expect(spawner.calls).toEqual([]);
  });

  it("ignores a second launch of a key that is already running", () => {
    // Double-clicking Run must not start a second copy that the panel then has
    // no way to stop, because the map only holds one handle per key.
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    launcher.launch("k", plan());
    expect(spawner.calls).toHaveLength(1);
  });

  it("stops tracking, and reports, when the process exits on its own", () => {
    const changes: { key: string; error?: string }[] = [];
    const launcher = new ProcessLauncher();
    launcher.setOnChange((key, error) => changes.push({ key, error }));
    launcher.launch("k", plan());

    spawner.children[0].emit("exit", 0);
    expect(launcher.isRunning("k")).toBe(false);
    expect(changes).toEqual([{ key: "k", error: undefined }]);
  });

  it("reports the reason when the spawn itself fails", () => {
    const changes: { key: string; error?: string }[] = [];
    const launcher = new ProcessLauncher();
    launcher.setOnChange((key, error) => changes.push({ key, error }));
    launcher.launch("k", plan());

    spawner.children[0].emit("error", new Error("EACCES"));
    expect(launcher.isRunning("k")).toBe(false);
    expect(changes).toEqual([{ key: "k", error: "EACCES" }]);
  });

  it("survives lifecycle events before any listener is registered", () => {
    // The launcher is constructed in the composition root before My Mods binds
    // its refresh callback; an unset listener must not throw.
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    expect(() => spawner.children[0].emit("exit", 0)).not.toThrow();
    expect(launcher.isRunning("k")).toBe(false);
  });

  it("ignores a late exit from a child that has already been replaced", () => {
    // Stop-then-Run reuses the key. The stopped process's exit arrives after
    // the restart; acting on it would untrack the *new*, live process and
    // leave it running with no way to stop it.
    const changes: string[] = [];
    const launcher = new ProcessLauncher();
    launcher.setOnChange((key) => changes.push(key));
    launcher.launch("k", plan());
    const first = spawner.children[0];
    launcher.stop("k");
    launcher.launch("k", plan());

    first.emit("exit", 0);
    expect(launcher.isRunning("k")).toBe(true);
    expect(changes).toEqual([]);
  });

  it("ignores a late error from a child that has already been replaced", () => {
    const changes: string[] = [];
    const launcher = new ProcessLauncher();
    launcher.setOnChange((key) => changes.push(key));
    launcher.launch("k", plan());
    const first = spawner.children[0];
    launcher.stop("k");
    launcher.launch("k", plan());

    first.emit("error", new Error("late"));
    expect(launcher.isRunning("k")).toBe(true);
    expect(changes).toEqual([]);
  });
});

describe("stop", () => {
  it("kills the whole process tree on Windows", () => {
    // Mod entrypoints are commonly a launcher that spawns the real exe; killing
    // only the direct child would leave the mod running invisibly.
    setPlatform("win32");
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    spawner.children[0].pid = 1234;

    launcher.stop("k");
    expect(launcher.isRunning("k")).toBe(false);
    expect(spawner.calls[1]).toEqual({
      cmd: "taskkill",
      args: ["/pid", "1234", "/T", "/F"],
      opts: { stdio: "ignore" },
    });
    expect(spawner.children[1].unrefCount).toBe(1);
  });

  it("signals the detached process group off Windows", () => {
    setPlatform("linux");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    spawner.children[0].pid = 4321;

    launcher.stop("k");
    // Negative pid targets the group the detached spawn created.
    expect(kill).toHaveBeenCalledWith(-4321);
  });

  it("untracks the key even when the process is already gone", () => {
    // A mod that exited between the panel's last refresh and the click would
    // otherwise stay listed as running forever.
    setPlatform("linux");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    expect(() => launcher.stop("k")).not.toThrow();
    expect(launcher.isRunning("k")).toBe(false);
  });

  it("does nothing for a key that was never launched", () => {
    expect(() => new ProcessLauncher().stop("unknown")).not.toThrow();
    expect(spawner.calls).toEqual([]);
  });

  it("untracks a child that never got a pid, with nothing to kill", () => {
    // A spawn that failed immediately has no pid; the entry must still clear.
    const launcher = new ProcessLauncher();
    launcher.launch("k", plan());
    spawner.children[0].pid = undefined;

    launcher.stop("k");
    expect(launcher.isRunning("k")).toBe(false);
    expect(spawner.calls).toHaveLength(1);
  });
});
