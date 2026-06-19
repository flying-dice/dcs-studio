<script lang="ts">
  // The DCS Console: the response-only log of every Lua run. File runs (the
  // editor's Run button / shortcut, or the file tree's "Run in DCS") and REPL
  // evals all land here (model `Workbench.RunLua` / `RunFile`). Authoring moved
  // out — to the files themselves and the right-panel REPL — so this panel is
  // purely output. Rendered as the bottom "Console" tool window.
  import { luaConsole } from "$lib/lua-console.svelte";
  import ConsoleLog from "./ConsoleLog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Trash2 } from "@lucide/svelte";
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="lua-console-panel">
  <div
    class="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1"
  >
    <span class="text-[11px] tracking-wide text-muted-foreground">DCS run output</span>
    <Button
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground hover:text-foreground"
      title="Clear output"
      aria-label="Clear output"
      data-testid="lua-console-clear"
      onclick={() => luaConsole.clear()}
    >
      <Trash2 />
    </Button>
  </div>
  <div class="min-h-0 flex-1">
    <ConsoleLog />
  </div>
</div>
