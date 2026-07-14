import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import type { EntrypointLaunchPlan } from "../../core/domain/entrypointLaunch";

// Tracked, detached process launcher for mod executable entrypoints. Mirrors the
// detached-spawn pattern of src/bridge/launch.ts (detached + stdio:"ignore" +
// unref) but, unlike the fire-and-forget DCS launch, KEEPS the child handle so
// the IDE can report running state and stop it. Keys are opaque strings the
// caller assigns (see core/domain/entrypointLaunch#entrypointRunKey).
//
// Lifecycle policy (see issue #9): Stop kills the whole process tree
// (taskkill /T /F on win32). On mod disable/uninstall the panel stops the mod's
// entrypoints first. On IDE exit the extension deliberately leaves processes
// running (matching the DCS launcher policy) — deactivate() does not touch this.
export class ProcessLauncher {
  private readonly running = new Map<string, ChildProcess>();
  /** Notified (with the key) whenever a tracked process exits or errors. */
  private onChange: (key: string, error?: string) => void = () => {};

  /** Register the change listener the panel uses to refresh its running state. */
  setOnChange(fn: (key: string, error?: string) => void): void {
    this.onChange = fn;
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  runningKeys(): string[] {
    return [...this.running.keys()];
  }

  /**
   * Spawn the entrypoint detached and track it. Throws synchronously if the exe
   * does not exist; a later spawn failure arrives via the change listener.
   */
  launch(key: string, plan: EntrypointLaunchPlan): void {
    if (this.running.has(key)) return;
    if (!fs.existsSync(plan.exe)) throw new Error(`Executable not found: ${plan.exe}`);
    const child = spawn(plan.exe, plan.args, { cwd: plan.cwd, detached: true, stdio: "ignore" });
    this.running.set(key, child);
    child.on("error", (e) => {
      this.running.delete(key);
      this.onChange(key, e.message);
    });
    child.on("exit", () => {
      if (!this.running.has(key)) return; // already reaped by an error
      this.running.delete(key);
      this.onChange(key);
    });
    child.unref();
  }

  /** Kill the tracked process tree for `key`. taskkill /T /F on win32. */
  stop(key: string): void {
    const child = this.running.get(key);
    if (!child) return;
    this.running.delete(key);
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } else {
      try {
        process.kill(-pid); // negative pid → the detached process group
      } catch {
        /* already gone */
      }
    }
  }
}
