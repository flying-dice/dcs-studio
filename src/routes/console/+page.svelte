<script lang="ts">
  // Standalone Lua REPL — the same component as the right-panel REPL tool;
  // reachable without opening a project, which is what the Playwright e2e
  // suite drives (the IDE view needs the native folder picker).
  import Repl from "$lib/components/Repl.svelte";
  import { Card } from "$lib/components/ui/card/index.js";
</script>

<div class="flex h-screen flex-col bg-background p-2 text-foreground">
  <Card class="flex min-h-0 flex-1 flex-col gap-0 rounded-xl py-0">
    <div class="flex h-9 shrink-0 items-center px-3">
      <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Lua REPL
      </span>
    </div>
    <div class="min-h-0 flex-1">
      <Repl />
    </div>
  </Card>
</div>
