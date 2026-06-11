// Build output store (model/studio/build.pds, issue #6 R1): owns the Output
// panel's lines and the build lifecycle. The backend streams cargo's
// stdout/stderr as `build://output` events and reports completion via
// `build://done`; this singleton accumulates them reactively.
//
// A separate singleton from `app` (same convention as `lang` in
// lang/intel.svelte.ts) so components read build state from one place.

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  buildProject,
  toolchainStatus,
  type BuildDone,
  type ToolchainStatus,
} from "$lib/api";

/** Output lines kept; beyond this the tail is dropped (one marker line). */
const MAX_LINES = 2000;

export class BuildStore {
  /** Accumulated output lines, oldest first. */
  lines = $state<string[]>([]);
  /** A build is in flight (set on start, cleared by `build://done`). */
  running = $state(false);
  /** How the last build ended, or null before any build completes. */
  lastOutcome = $state<BuildDone | null>(null);
  /** Detected Rust toolchain, or null until the first refresh. */
  toolchain = $state<ToolchainStatus | null>(null);

  // Persistent listeners are set up once, on first use.
  private listening = false;

  private append(line: string) {
    if (this.lines.length === MAX_LINES) {
      this.lines.push("… output truncated …");
      return;
    }
    if (this.lines.length > MAX_LINES) return;
    this.lines.push(line);
  }

  // Sharing one listener pair across all builds is safe because the
  // backend's BuildState guard allows a single build at a time — two
  // builds' events can never interleave on these channels.
  private async ensureListeners(): Promise<void> {
    if (this.listening) return;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen<string>("build://output", (e) => {
          this.append(e.payload);
        }),
      );
      attached.push(
        await listen<BuildDone>("build://done", (e) => {
          this.lastOutcome = e.payload;
          this.running = false;
          if (e.payload.no_op) {
            this.append("Nothing to build — not a Rust project.");
          } else {
            this.append(
              e.payload.succeeded
                ? "Build succeeded."
                : `Build failed (exit code ${e.payload.exit_code}).`,
            );
          }
        }),
      );
      // Flag only flips once BOTH listeners are attached; a rejection
      // leaves it false so a later start() retries from scratch.
      this.listening = true;
    } catch (error) {
      this.listening = false;
      for (const unlisten of attached) unlisten();
      throw error;
    }
  }

  /** Start a build of the project at `root` (model `Builder.RunBuild`). */
  async start(root: string): Promise<void> {
    if (this.running) return;
    this.lines = [];
    this.lastOutcome = null;
    if (!isTauri()) {
      // Plain browser (vite dev, Playwright): no backend to build with.
      this.append("Build requires the desktop app.");
      return;
    }
    this.running = true;
    try {
      await this.ensureListeners();
      await buildProject(root);
    } catch (error) {
      // Listener attachment failures and guard failures (missing cargo,
      // build already running) reject before anything streams.
      this.running = false;
      this.append(String(error));
    }
  }

  /** Re-probe cargo/rustup (model `Builder.DetectToolchain`). */
  async refreshToolchain(): Promise<void> {
    if (!isTauri()) return;
    try {
      this.toolchain = await toolchainStatus();
    } catch {
      /* backend not ready — the hint line just stays unknown */
    }
  }
}

export const build = new BuildStore();
