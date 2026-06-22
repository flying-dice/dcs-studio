// Dependencies output store (model/studio/cargolua.pds `CargoLuaTasks`, issue
// #51): owns the Dependencies panel's lines and the fetch/bundle lifecycle. The
// backend streams progress as `cargolua://output` events and reports completion
// via `cargolua://done`; this singleton accumulates them reactively — the same
// shape as the build store (build.svelte.ts), one task at a time.
//
// On a successful FETCH it re-indexes the workspace (model
// `FetchReindexesWithoutReopen`) so a freshly vendored dependency's modules
// resolve, complete, and hover without reopening the project.

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { luaCargoBundle, luaCargoFetch, type CargoLuaDone } from "$lib/api";
import { lang } from "$lib/lang/intel.svelte";

/** Output lines kept; beyond this the tail is dropped (one marker line). */
const MAX_LINES = 2000;

type Task = CargoLuaDone["task"];

export class CargoLuaStore {
  /** Accumulated output lines, oldest first. */
  lines = $state<string[]>([]);
  /** A fetch or bundle is in flight (set on start, cleared by `cargolua://done`). */
  running = $state(false);
  /** The task running now, or the last one run; null before any run. */
  task = $state<Task | null>(null);
  /** How the last run ended, or null before any completes. */
  lastOutcome = $state<CargoLuaDone | null>(null);

  // Persistent listeners are set up once, on first use.
  private listening = false;
  // The root of the in-flight task, captured so a successful fetch can re-index
  // it from the (asynchronous) done event.
  private activeRoot: string | null = null;

  private append(line: string) {
    if (this.lines.length === MAX_LINES) {
      this.lines.push("… output truncated …");
      return;
    }
    if (this.lines.length > MAX_LINES) return;
    this.lines.push(line);
  }

  // One listener pair across all runs is safe: the backend's CargoLuaState guard
  // allows a single task at a time, so two runs' events can never interleave.
  private async ensureListeners(): Promise<void> {
    if (this.listening) return;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen<string>("cargolua://output", (e) => {
          this.append(e.payload);
        }),
      );
      attached.push(
        await listen<CargoLuaDone>("cargolua://done", (e) => {
          this.lastOutcome = e.payload;
          this.running = false;
          this.append(
            e.payload.succeeded
              ? e.payload.summary
              : `Failed: ${e.payload.summary}`,
          );
          // A successful fetch added modules under .lua-cargo/deps that the
          // analyzer only walks at initialize — re-index so they light up now,
          // without reopening the project (model FetchReindexesWithoutReopen).
          if (
            e.payload.task === "fetch" &&
            e.payload.succeeded &&
            this.activeRoot
          ) {
            void lang.reindex(this.activeRoot);
          }
        }),
      );
      // Flag flips only once BOTH listeners attach; a rejection leaves it false
      // so a later start retries from scratch.
      this.listening = true;
    } catch (error) {
      this.listening = false;
      for (const unlisten of attached) unlisten();
      throw error;
    }
  }

  /** Fetch the project's dependencies (model `CargoLuaTasks.Fetch`). */
  async fetch(root: string): Promise<void> {
    await this.run("fetch", root, () => luaCargoFetch(root));
  }

  /** Bundle the project's `[[bundle]]` targets (model `CargoLuaTasks.Bundle`). */
  async bundle(root: string): Promise<void> {
    await this.run("bundle", root, () => luaCargoBundle(root));
  }

  private async run(
    task: Task,
    root: string,
    start: () => Promise<void>,
  ): Promise<void> {
    if (this.running) return;
    this.lines = [];
    this.lastOutcome = null;
    this.task = task;
    this.activeRoot = root;
    if (!isTauri()) {
      // Plain browser (vite dev, Playwright): no backend to run lua-cargo with.
      this.append("Dependencies require the desktop app.");
      return;
    }
    this.running = true;
    try {
      await this.ensureListeners();
      await start();
    } catch (error) {
      // Listener attachment + guard failures (busy, missing manifest) reject
      // before anything streams.
      this.running = false;
      this.append(String(error));
    }
  }
}

export const cargolua = new CargoLuaStore();
