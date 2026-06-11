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
  import type { LanguageProvider } from "$lib/lang/provider";

  const PATH = "lab/main.lua";
  const INITIAL = "--- Doc for f.\nlocal f = function() end\nfunction g() end\n";

  let host: HTMLDivElement;
  let ready = $state(false);
  let provider: LanguageProvider | null = null;
  let hoverTitle = $state("");
  let hoverBody = $state("");

  // Hover probe: ask the real provider for the card over `f`'s
  // declaration in the seeded text, render it for the e2e suite.
  async function probeHover(): Promise<void> {
    const offset = INITIAL.indexOf("local f") + "local ".length;
    const hover = (await provider?.hover(PATH, offset)) ?? null;
    hoverTitle = hover?.title ?? "(none)";
    hoverBody = hover?.body ?? "";
  }

  onMount(() => {
    let view: EditorView | undefined;
    void (async () => {
      lang.engineStatus = "loading";
      try {
        provider = providerFor(PATH);
        if (!provider) throw new Error(`no provider for ${PATH}`);
        await provider.mount([{ path: PATH, text: INITIAL }], [], "lab");
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
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="hover-probe"
      onclick={probeHover}
    >
      hover probe
    </button>
    <span data-testid="hover-title">{hoverTitle}</span>
    <span class="text-muted-foreground" data-testid="hover-body"
      >{hoverBody}</span
    >
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
