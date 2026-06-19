// Shared Lua-console store (model studio::core Workbench.RunLua): holds the run
// log and the eval action so both the Lua Console panel and the editor's
// "Run Selection in Lua Console" feed the SAME log. The console's input editor
// stays component-local; only the shared state lives here.

import { dcsCall, readTextFile } from "./api";
import { app } from "./state.svelte";
import { canonicalPath } from "./paths";
import { errorMessage } from "$lib/utils";
import type { EditorView } from "@codemirror/view";

export interface ConsoleEntry {
  code: string;
  ok: boolean;
  output: string;
  at: Date;
}

function formatResult(result: unknown): string {
  if (result === null || result === undefined) return "nil";
  return JSON.stringify(result, null, 2);
}

class LuaConsoleStore {
  entries = $state<ConsoleEntry[]>([]);
  running = $state(false);

  /** Eval `code` in the DCS GUI/hooks environment and append the result (or
   * error) to the log. A blank snippet, or a run already in flight, is a
   * no-op. The timestamp is captured when the run resolves. */
  async run(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed || this.running) return;
    this.running = true;
    try {
      const result = await dcsCall("eval", { code: trimmed });
      this.entries.push({
        code: trimmed,
        ok: true,
        output: formatResult(result),
        at: new Date(),
      });
    } catch (e) {
      this.entries.push({
        code: trimmed,
        ok: false,
        output: errorMessage(e),
        at: new Date(),
      });
    } finally {
      this.running = false;
    }
  }

  clear(): void {
    this.entries = [];
  }
}

export const luaConsole = new LuaConsoleStore();

/** Run the file at `path` in DCS (model `Workbench.RunFile`): a loaded tab's live
 *  buffer wins over on-disk text so unsaved edits run as written — even when the
 *  buffer is empty — else the file is read from disk; the result lands in the
 *  console log and the Console panel is surfaced. A read failure rejects — it
 *  never enters the log. */
export async function runFile(path: string): Promise<void> {
  // Canonicalise to match `openFiles[].path` (set by `openFile`), so an open tab
  // is found whatever case its drive letter arrives in.
  const canonical = canonicalPath(path);
  const open = app.openFiles.find((f) => f.path === canonical);
  // The buffer is authoritative for a loaded TEXT tab — even if emptied; a
  // loading/binary/absent tab falls back to disk.
  const text = open?.kind === "text" ? open.docText : await readTextFile(canonical);
  app.bottomTool = "lua";
  await luaConsole.run(text);
}

/** Run a CodeMirror view's current selection — or its whole doc when nothing is
 *  selected — in DCS; the result lands in the Console. The one editor Run
 *  gesture: the editor keymap/menu and the tab-strip Run button both route here,
 *  so they stay in lock-step. */
export function runViewInDcs(view: EditorView): void {
  const { from, to } = view.state.selection.main;
  const code = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
  app.bottomTool = "lua";
  void luaConsole.run(code);
}
