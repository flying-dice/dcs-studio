<script lang="ts">
  // Browser test surface for the language engine (like /console for the
  // bridge): a bare CodeMirror wired through the real provider stack —
  // wasm engine, LanguageIntel store, Problems panel — with an in-memory
  // workspace, so the Playwright suite needs neither Tauri nor DCS.
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import Problems from "$lib/components/Problems.svelte";
  import { providerFor } from "$lib/lang/registry";
  import { langIntelFor } from "$lib/lang/codemirror";
  import { lang } from "$lib/lang/intel.svelte";

  const PATH = "lab/main.lua";
  const INITIAL = "function f() end\n";

  let host: HTMLDivElement;
  let ready = $state(false);

  onMount(() => {
    let view: EditorView | undefined;
    void (async () => {
      lang.engineStatus = "loading";
      try {
        const provider = providerFor(PATH);
        if (!provider) throw new Error(`no provider for ${PATH}`);
        await provider.mount([{ path: PATH, text: INITIAL }], []);
        lang.engineStatus = "ready";
      } catch (error) {
        console.error("language engine failed to mount:", error);
        lang.engineStatus = "failed";
        return;
      }
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: INITIAL,
          extensions: [basicSetup, langIntelFor(PATH)],
        }),
      });
      ready = true;
    })();
    return () => view?.destroy();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="lua-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-engine-status">
    engine: {lang.engineStatus}{ready ? " · editor ready" : ""}
  </div>
  <div
    class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
    data-testid="lab-editor"
    bind:this={host}
  ></div>
  <div class="h-48 shrink-0 overflow-hidden rounded border">
    <Problems />
  </div>
</div>
