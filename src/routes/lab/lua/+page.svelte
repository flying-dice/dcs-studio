<script lang="ts">
  // Test surface for the language engine (like /console for the bridge): a
  // bare CodeMirror wired through the real provider stack — the hosted
  // lua-analyzer, the LanguageIntel store, the Problems panel. The e2e-lang
  // suite drives this against the real app over WebView2 CDP.
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import Problems from "$lib/components/Problems.svelte";
  import { providerFor } from "$lib/lang/registry";
  import { langIntelFor } from "$lib/lang/codemirror";
  import { lang } from "$lib/lang/intel.svelte";
  import type { LanguageProvider } from "$lib/lang/provider";

  // Absolute, with backslashes, so it both round-trips through the hosted
  // server's file:// URIs (a driveless relative path fails `Url::to_file_path`
  // on Windows) AND matches the path the server's published diagnostics carry
  // back: `uriToPath` canonicalises to backslashes, and the Problems panel's
  // per-file filter (`fileDiagnostics`) compares paths exactly — a forward-slash
  // PATH would surface in the panel but never paint a squiggle.
  const PATH = "C:\\dcs-studio-lab\\main.lua";
  // The multibyte comment line makes UTF-16 and byte offsets diverge
  // before `f` — the probe's indexOf offset (UTF-16) only resolves if
  // the provider converts to bytes at the engine boundary. The lines after
  // the hover fixture seed the completion probes: an inferred local literal
  // (`cfg`), a dotted-global table (`DCS`), a scope-vs-workspace prefix
  // (`spawnRate` local + `spawnUnit` global), and the trailing comment.
  const INITIAL =
    "-- наводка °\n" +
    "--- Doc for f.\n" +
    "local f = function() end\n" +
    "function g() end\n" +
    "local spawnRate = 2\n" +
    'local cfg = { speed = 1, name = "x", start = function() end }\n' +
    "function spawnUnit(country, name) end\n" +
    "DCS = {}\n" +
    "DCS.spawn = function(unit) end\n" +
    "DCS.version = 1\n" +
    "local member = cfg.\n" +
    "local dotted = DCS.\n" +
    "local pick = spaw\n";

  let host: HTMLDivElement;
  let ready = $state(false);
  let provider: LanguageProvider | null = null;
  let hoverTitle = $state("");
  let hoverBody = $state("");
  let completionResult = $state("");

  // Hover probe: ask the real provider for the card over `f`'s
  // declaration in the seeded text, render it for the e2e suite.
  async function probeHover(): Promise<void> {
    const offset = INITIAL.indexOf("local f") + "local ".length;
    const hover = (await provider?.hover(PATH, offset)) ?? null;
    hoverTitle = hover?.title ?? "(none)";
    hoverBody = hover?.body ?? "";
  }

  // Completion probe: complete just past `marker` (its first occurrence) and
  // render the items as JSON for the e2e suite to parse — the deterministic
  // counterpart to driving the editor's autocomplete popup by hand.
  async function probeComplete(marker: string): Promise<void> {
    const offset = INITIAL.indexOf(marker) + marker.length;
    const items = (await provider?.complete(PATH, offset)) ?? [];
    completionResult = JSON.stringify(items);
  }

  onMount(() => {
    let view: EditorView | undefined;
    void (async () => {
      lang.engineStatus = "loading";
      try {
        provider = providerFor(PATH);
        if (!provider) throw new Error(`no provider for ${PATH}`);
        await provider.mount([{ path: PATH, text: INITIAL }], [], "lab");
        // Observe the hosted server's late publishes so diagnostics that
        // arrive after a lint pass repaint as squiggles + reach the Problems
        // panel (mountWorkspace does this for the real app; this lab mounts
        // the provider directly).
        lang.observePush(provider);
        // Open the seed file so the hosted lua-analyzer keys the buffer: it
        // answers positional queries (hover/symbols) only for didOpen-ed
        // documents. Mirrors the IDE opening a file after the project mounts.
        await provider.setSource(PATH, INITIAL);
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
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="completion-members-probe"
      onclick={() => probeComplete("= cfg.")}
    >
      members
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="completion-dotted-probe"
      onclick={() => probeComplete("= DCS.")}
    >
      dotted
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="completion-scope-probe"
      onclick={() => probeComplete("= spaw")}
    >
      scope
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="completion-comment-probe"
      onclick={() => probeComplete("наводка")}
    >
      comment
    </button>
    <span class="text-muted-foreground" data-testid="completion-result"
      >{completionResult}</span
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
