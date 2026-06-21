// Run configurations, WebStorm-style. There is no bare run button: the
// ephemeral "Current File" config is the default, and right-clicking a file
// makes a config pinned to it ("Run 'main.lua'" / "Debug 'main.lua'"). A config
// carries a `target` — only "dcs" today (the bridge: eval for Run, debug_run
// for Debug); a future "local" target runs a local Lua interpreter. The
// RunWidget in the editor strip and the Run menu drive the selected config.

import { app } from "$lib/state.svelte";
import { debug } from "$lib/debug-session.svelte";
import { runFile, runViewInDcs } from "$lib/lua-console.svelte";
import { editorViewFor } from "$lib/lang/codemirror";

export type RunTarget = "dcs"; // | "local" — deferred

export interface RunConfig {
  id: string; // "current-file" | `file:${path}`
  name: string; // "Current File" | the file's base name
  /** null = whatever file is active in the editor (the "Current File" config). */
  path: string | null;
  target: RunTarget;
}

const CURRENT_FILE: RunConfig = {
  id: "current-file",
  name: "Current File",
  path: null,
  target: "dcs",
};

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Only Lua scripts are runnable: Run/Debug `loadstring` the buffer as Lua in
 * the sim, so non-`.lua` files (Rust, TOML, JSON, …) are never run/debugged. */
export function isLuaFile(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith(".lua");
}

class RunConfigStore {
  configs = $state<RunConfig[]>([CURRENT_FILE]);
  selectedId = $state<string>(CURRENT_FILE.id);

  get selected(): RunConfig {
    return this.configs.find((c) => c.id === this.selectedId) ?? CURRENT_FILE;
  }

  /** The widget label — "Current File" reflects the active file, WebStorm-style. */
  get label(): string {
    const c = this.selected;
    if (c.path) return c.name;
    const p = app.filePath;
    return p ? `Current File — ${baseName(p)}` : "Current File";
  }

  /** The file a config resolves to right now (Current File → active editor). */
  resolvePath(config: RunConfig = this.selected): string | null {
    return config.path ?? app.filePath;
  }

  /** Whether Run/Debug can fire: a resolvable file that is a `.lua` script. */
  get ready(): boolean {
    return isLuaFile(this.resolvePath());
  }

  select(id: string): void {
    this.selectedId = id;
  }

  /** Drop a pinned config (the ephemeral Current File can't be removed). */
  remove(id: string): void {
    if (id === CURRENT_FILE.id) return;
    this.configs = this.configs.filter((c) => c.id !== id);
    if (this.selectedId === id) this.selectedId = CURRENT_FILE.id;
  }

  /** Create (or reuse) a config pinned to `path` and select it. */
  configForFile(path: string): RunConfig {
    const id = `file:${path}`;
    let config = this.configs.find((c) => c.id === id);
    if (!config) {
      config = { id, name: baseName(path), path, target: "dcs" };
      this.configs = [...this.configs, config];
    }
    this.selectedId = id;
    return config;
  }

  /** Run a config in DCS (plain eval; selection-aware for the active file). */
  run(config: RunConfig = this.selected): void {
    const path = this.resolvePath(config);
    if (!isLuaFile(path)) return;
    const view = config.path == null ? editorViewFor(path!) : undefined;
    if (view) runViewInDcs(view);
    else void runFile(path!).catch((e) => console.error("Run failed:", e));
  }

  /** Debug a config under the in-sim line-hook debugger. */
  debug(config: RunConfig = this.selected): void {
    const path = this.resolvePath(config);
    if (!isLuaFile(path)) return;
    void debug.start(path!);
  }

  /** Right-click "Run '<file>'": pin a config for the file and run it (Lua only). */
  runFileTarget(path: string): void {
    if (!isLuaFile(path)) return;
    this.run(this.configForFile(path));
  }

  /** Right-click "Debug '<file>'": pin a config for the file and debug it (Lua only). */
  debugFileTarget(path: string): void {
    if (!isLuaFile(path)) return;
    this.debug(this.configForFile(path));
  }
}

export const runConfig = new RunConfigStore();
