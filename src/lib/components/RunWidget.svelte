<script lang="ts">
  // The run-configuration widget for the editor strip, WebStorm-style:
  // a config selector ("Current File" by default) plus Run / Debug / Stop.
  // No bare play button — the selector is the entry point.
  import { Button } from "$lib/components/ui/button/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Play, Bug, Square, ChevronDown, Check, X, FileCode } from "@lucide/svelte";
  import { runConfig } from "$lib/run-config.svelte";
  import { debug } from "$lib/debug-session.svelte";

  const ready = $derived(runConfig.ready);
  const debugging = $derived(debug.status !== "idle");
</script>

<div class="flex shrink-0 items-center gap-0.5">
  <!-- Run configuration selector -->
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          class="flex max-w-56 items-center gap-1 rounded px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
          title="Run configuration"
          data-testid="run-config-select"
        >
          <FileCode class="size-3.5 shrink-0 opacity-70" />
          <span class="truncate">{runConfig.label}</span>
          <ChevronDown class="size-3 shrink-0 opacity-60" />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="min-w-56">
      <DropdownMenu.Label class="text-[11px] text-muted-foreground">
        Run configuration
      </DropdownMenu.Label>
      <DropdownMenu.Separator />
      {#each runConfig.configs as c (c.id)}
        <DropdownMenu.Item
          class="flex items-center justify-between gap-2"
          onclick={() => runConfig.select(c.id)}
        >
          <span class="flex min-w-0 items-center gap-1.5">
            {#if runConfig.selectedId === c.id}
              <Check class="size-3.5 shrink-0 text-primary" />
            {:else}
              <span class="size-3.5 shrink-0"></span>
            {/if}
            <span class="truncate">{c.path ? c.name : "Current File"}</span>
            <span class="shrink-0 rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {c.target}
            </span>
          </span>
          {#if c.path}
            <button
              class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Remove configuration"
              onclick={(e) => {
                e.stopPropagation();
                runConfig.remove(c.id);
              }}
            >
              <X class="size-3" />
            </button>
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <!-- Run -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          class="text-emerald-500 hover:text-emerald-400 disabled:text-muted-foreground/40"
          disabled={!ready}
          onclick={() => runConfig.run()}
          aria-label="Run"
          data-testid="run-config-run"
        >
          <Play />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" class="font-mono text-[11px] tracking-wide">Run (⇧F10)</Tooltip.Content>
  </Tooltip.Root>

  <!-- Debug -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40"
          disabled={!ready || debugging}
          onclick={() => runConfig.debug()}
          aria-label="Debug"
          data-testid="run-config-debug"
        >
          <Bug />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" class="font-mono text-[11px] tracking-wide">Debug (⇧F9)</Tooltip.Content>
  </Tooltip.Root>

  <!-- Stop (only meaningful with a live debug session) -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          class="text-destructive hover:text-destructive/80 disabled:text-muted-foreground/40"
          disabled={!debugging}
          onclick={() => debug.stop()}
          aria-label="Stop"
          data-testid="run-config-stop"
        >
          <Square />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" class="font-mono text-[11px] tracking-wide">Stop</Tooltip.Content>
  </Tooltip.Root>
</div>
