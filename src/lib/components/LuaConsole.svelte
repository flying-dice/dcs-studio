<script lang="ts">
  // Lua console: execute arbitrary Lua in the DCS GUI/hooks environment via
  // the bridge's `eval` JSON-RPC method, and show each run's result or error.
  // Rendered as the IDE's bottom "Lua Console" tool window and standalone at
  // /console (which the Playwright e2e suite drives).
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { keymap } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { app } from "$lib/state.svelte";
  import { dcsCall } from "$lib/api";
  import { cn } from "$lib/utils.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Play, Trash2, LoaderCircle } from "@lucide/svelte";

  interface ConsoleEntry {
    code: string;
    ok: boolean;
    output: string;
    at: Date;
  }

  let host: HTMLDivElement;
  let outputHost: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;
  let running = $state(false);
  let entries = $state<ConsoleEntry[]>([]);

  const themeComp = new Compartment();

  function formatResult(result: unknown): string {
    if (result === null || result === undefined) return "nil";
    return JSON.stringify(result, null, 2);
  }

  async function run() {
    const code = view?.state.doc.toString().trim();
    if (!code || running) return;
    running = true;
    try {
      const result = await dcsCall("eval", { code });
      entries.push({ code, ok: true, output: formatResult(result), at: new Date() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      entries.push({ code, ok: false, output: message, at: new Date() });
    } finally {
      running = false;
    }
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'return DCS.getModelTime()',
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                void run();
                return true;
              },
            },
          ]),
          StreamLanguage.define(lua),
          themeComp.of(app.cm),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
          }),
        ],
      }),
    });
    return () => view?.destroy();
  });

  // Live theme swap (same pattern as Editor.svelte).
  $effect(() => {
    const cm = app.cm;
    view?.dispatch({ effects: themeComp.reconfigure(cm) });
  });

  // Keep the latest run in view.
  $effect(() => {
    entries.length;
    outputHost?.scrollTo({ top: outputHost.scrollHeight });
  });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="lua-console">
  <!-- Input island: editor + run controls -->
  <div class="flex min-h-0 flex-[2] gap-1 border-b border-border/60">
    <div
      class="h-full min-w-0 flex-1 overflow-hidden [&_.cm-editor]:h-full"
      data-testid="lua-console-input"
      bind:this={host}
    ></div>
    <div class="flex shrink-0 flex-col gap-1 p-1">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        title="Run in DCS (Ctrl+Enter)"
        aria-label="Run in DCS"
        data-testid="lua-console-run"
        disabled={running}
        onclick={() => run()}
      >
        {#if running}
          <LoaderCircle class="animate-spin" />
        {:else}
          <Play />
        {/if}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        title="Clear output"
        aria-label="Clear output"
        data-testid="lua-console-clear"
        onclick={() => (entries = [])}
      >
        <Trash2 />
      </Button>
    </div>
  </div>

  <!-- Output: one block per run, newest at the bottom -->
  <div
    class="min-h-0 flex-[3] overflow-auto px-3 py-2"
    data-testid="lua-console-output"
    bind:this={outputHost}
  >
    {#if entries.length === 0}
      <p class="text-[11px] tracking-wide text-muted-foreground">
        Lua runs in the DCS GUI environment (DCS.*, net.*, lfs) — Ctrl+Enter to run.
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
</div>
