<script lang="ts">
  // The shared eval log (model `ConsoleEntry` history): one block per run,
  // newest at the bottom. Rendered read-only in the bottom Console panel and
  // inside the right-panel REPL — both are views of the one `luaConsole` log,
  // so a file run and a REPL eval both show up wherever the log is on screen.
  import { luaConsole } from "$lib/lua-console.svelte";
  import { cn } from "$lib/utils.js";

  const entries = $derived(luaConsole.entries);
  let outputHost: HTMLDivElement | undefined = $state();

  // Keep the latest run in view.
  $effect(() => {
    entries.length;
    outputHost?.scrollTo({ top: outputHost.scrollHeight });
  });
</script>

<div
  class="h-full min-h-0 overflow-auto px-3 py-2"
  data-testid="lua-console-output"
  bind:this={outputHost}
>
  {#if entries.length === 0}
    <p class="text-[11px] tracking-wide text-muted-foreground">
      Run a file in DCS (right-click a file, or the editor's Run button), or use the REPL — results
      appear here.
    </p>
  {/if}
  {#each entries as entry, i (i)}
    <div class="mb-2 font-mono text-xs" data-testid="console-entry" data-ok={entry.ok}>
      <div class="flex items-baseline gap-2 text-muted-foreground">
        <span class="select-none opacity-60">&gt;</span>
        <span class="truncate whitespace-pre" title={entry.code}>{entry.code}</span>
      </div>
      <pre
        class={cn(
          "mt-0.5 whitespace-pre-wrap break-all pl-4",
          entry.ok ? "text-foreground" : "text-destructive",
        )}
        data-testid="entry-output">{entry.output}</pre>
    </div>
  {/each}
</div>
