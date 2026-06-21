<script lang="ts">
  // The Debug tool window (model/studio/debug.pds), shaped after IntelliJ's
  // Debug tool window: session controls (Resume / Stop), a stepping toolbar
  // (Step Over / Into / Out), a Frames pane (the call stack), and a Variables
  // pane (the selected frame's scopes as a lazy tree). Reads the debug-session
  // singleton.
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import {
    Play,
    Pause,
    Square,
    ArrowRightToLine,
    ArrowDownToLine,
    ArrowUpToLine,
    Bug,
    Circle,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import { debug } from "$lib/debug-session.svelte";
  import { app } from "$lib/state.svelte";
  import VariableNode from "./VariableNode.svelte";
  import WatchesPane from "./WatchesPane.svelte";
  import DebugConsole from "./DebugConsole.svelte";
  import BreakpointsView from "./BreakpointsView.svelte";

  const paused = $derived(debug.status === "paused");
  const running = $derived(debug.status === "running");
  const active = $derived(debug.status !== "idle");
  const frames = $derived(debug.frames);
  const frame = $derived(debug.frame);

  let view = $state<"debug" | "breakpoints">("debug");

  function fileOf(source: string): string {
    const p = source.startsWith("=") ? source.slice(1) : source;
    return p.split(/[\\/]/).pop() ?? p;
  }

  const statusText = $derived.by(() => {
    if (debug.status === "idle") return "No active session";
    if (debug.status === "running") return "Running…";
    const top = frames[0];
    if (top) return `Paused at ${fileOf(top.source)}:${top.line}`;
    return "Paused";
  });

  function selectFrame(index: number): void {
    debug.selectFrame(index);
    const f = debug.frames[index];
    if (f) {
      const p = f.source.startsWith("=") ? f.source.slice(1) : f.source;
      app.openFile(p, p.split(/[\\/]/).pop() ?? p, { line: f.line, col: 1 });
    }
  }
</script>

{#snippet ctl(
  icon: Component,
  label: string,
  onClick: () => void,
  enabled: boolean,
  tone?: "go" | "stop",
)}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          disabled={!enabled}
          onclick={onClick}
          class={tone === "go"
            ? "text-emerald-500 hover:text-emerald-400 disabled:text-muted-foreground/40"
            : tone === "stop"
              ? "text-destructive hover:text-destructive/80 disabled:text-muted-foreground/40"
              : "text-muted-foreground hover:text-foreground disabled:text-muted-foreground/40"}
          aria-label={label}
        >
          {@const Icon = icon}
          <Icon />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="top" class="font-mono text-[11px] tracking-wide">
      {label}
    </Tooltip.Content>
  </Tooltip.Root>
{/snippet}

<div class="flex h-full flex-col">
  <!-- Session + stepping toolbar -->
  <div class="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
    {@render ctl(Play, "Resume (F9)", () => debug.resume(), paused, "go")}
    {@render ctl(Pause, "Pause", () => debug.pause(), running)}
    {@render ctl(Square, "Stop", () => debug.stop(), active, "stop")}
    <div class="mx-1 h-4 w-px bg-border/60"></div>
    {@render ctl(ArrowRightToLine, "Step Over (F8)", () => debug.stepOver(), paused)}
    {@render ctl(ArrowDownToLine, "Step Into (F7)", () => debug.stepInto(), paused)}
    {@render ctl(ArrowUpToLine, "Step Out (Shift+F8)", () => debug.stepOut(), paused)}
    <div class="mx-1 h-4 w-px bg-border/60"></div>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            variant="ghost"
            size="icon-sm"
            onclick={() => (view = view === "breakpoints" ? "debug" : "breakpoints")}
            class={view === "breakpoints"
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground"}
            aria-label="Breakpoints"
          >
            <Circle class="fill-current" />
          </Button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="top" class="font-mono text-[11px] tracking-wide">Breakpoints</Tooltip.Content>
    </Tooltip.Root>
    <span class="ml-2 truncate font-mono text-[11px] text-muted-foreground">{statusText}</span>
    {#if debug.error}
      <span class="ml-2 truncate text-[11px] text-destructive" title={debug.error}>
        {debug.error}
      </span>
    {/if}
  </div>

  {#if view === "breakpoints"}
    <BreakpointsView />
  {:else if !active}
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-muted-foreground">
      <Bug class="size-5 opacity-50" />
      <p class="text-[12px]">No debug session.</p>
      <p class="text-[11px] opacity-70">
        Set a breakpoint in the gutter, then click <span class="text-foreground">Debug</span>.
      </p>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- Frames (call stack) -->
      <div class="flex w-1/4 min-w-40 flex-col border-r border-border/60">
        <div class="shrink-0 border-b border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
          Frames
        </div>
        <div class="min-h-0 flex-1">
          <ScrollArea class="h-full">
            {#if paused && frames.length > 0}
              {#each frames as f (f.index)}
                <button
                  class={"flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-[12px] hover:bg-accent/40 " +
                    (debug.selectedFrame === f.index ? "bg-primary/15" : "")}
                  onclick={() => selectFrame(f.index)}
                >
                  <span
                    class={"size-1.5 shrink-0 rounded-full " +
                      (f.index === 0 ? "bg-emerald-500" : "bg-muted-foreground/40")}
                  ></span>
                  <span class="shrink-0 text-foreground">{f.name}</span>
                  <span class="truncate text-muted-foreground/70">
                    {fileOf(f.source)}:{f.line}
                  </span>
                </button>
              {/each}
            {:else}
              <p class="px-2 py-1 text-[11px] text-muted-foreground/70">Running — no frame.</p>
            {/if}
          </ScrollArea>
        </div>
      </div>

      <!-- Middle: Watches over the Variables tree. Keyed by pause + frame so
           the tree (and its cached refs) resets on each stop. -->
      <div class="flex min-w-0 flex-1 flex-col border-r border-border/60">
        <div class="h-1/3 min-h-20 shrink-0 border-b border-border/60">
          <WatchesPane />
        </div>
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="shrink-0 border-b border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
            Variables
          </div>
          <div class="min-h-0 flex-1">
            <ScrollArea class="h-full">
              {#if paused && frame}
                {#key `${debug.pauseSeq}:${debug.selectedFrame}`}
                  {#each frame.scopes as scope (scope.name)}
                    <VariableNode name={scope.name} vref={scope.ref} />
                  {/each}
                {/key}
              {:else}
                <p class="px-2 py-1 text-[11px] text-muted-foreground/70">
                  Variables appear when paused at a breakpoint.
                </p>
              {/if}
            </ScrollArea>
          </div>
        </div>
      </div>

      <!-- Right: the evaluate console. -->
      <div class="flex w-1/3 min-w-52 flex-col">
        <DebugConsole />
      </div>
    </div>
  {/if}
</div>
