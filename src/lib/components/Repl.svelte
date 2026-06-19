<script lang="ts">
  // The Lua REPL: author ad-hoc snippets and run them in the DCS GUI/hooks
  // environment via the bridge's `eval` (model `Workbench.RunLua`); results
  // stream into the shared console log below. The interactive counterpart to
  // the response-only Console panel — rendered as the right-panel "REPL" tool
  // window and standalone at /console (which the Playwright e2e suite drives).
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { keymap } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { app } from "$lib/state.svelte";
  import { luaConsole } from "$lib/lua-console.svelte";
  import ConsoleLog from "./ConsoleLog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Play, Trash2, LoaderCircle } from "@lucide/svelte";

  let host: HTMLDivElement;
  let view: EditorView | undefined;
  const running = $derived(luaConsole.running);
  const themeComp = new Compartment();

  async function run() {
    await luaConsole.run(view?.state.doc.toString() ?? "");
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "return DCS.getModelTime()",
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
        onclick={() => luaConsole.clear()}
      >
        <Trash2 />
      </Button>
    </div>
  </div>

  <!-- Shared eval log (newest at the bottom). -->
  <div class="min-h-0 flex-[3]">
    <ConsoleLog />
  </div>
</div>
