// Shared Lua-console store (model studio::core Workbench.RunLua): holds the run
// log and the eval action so both the Lua Console panel and the editor's
// "Run Selection in Lua Console" feed the SAME log. The console's input editor
// stays component-local; only the shared state lives here.

import { dcsCall } from "./api";
import { errorMessage } from "$lib/utils";

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
