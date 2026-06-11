<script lang="ts">
  // Browser test surface for the Structure panel (like /lab/lua for
  // diagnostics): a bare CodeMirror wired through the real provider stack
  // plus the real Structure component, so the Playwright suite can assert
  // outline contents, click-to-navigate, and cursor following — no Tauri,
  // no DCS.
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import Structure from "$lib/components/Structure.svelte";
  import { providerFor } from "$lib/lang/registry";
  import { langIntelFor } from "$lib/lang/codemirror";
  import { lang } from "$lib/lang/intel.svelte";

  const LUA_PATH = "lab/main.lua";
  // A second claimed file — drives the stale-outline regression: switching
  // between two Lua files must never show the previous file's rows.
  const OTHER_PATH = "lab/other.lua";
  const OTHER = `function alpha() end\n`;
  // A file no provider claims — drives the "no structure" rendering.
  const TEXT_PATH = "lab/notes.txt";
  // The multibyte comment makes UTF-16 and byte offsets diverge before
  // every declaration, so navigation only lands on names if the wasm
  // path's byte spans are converted at the provider boundary.
  const INITIAL = `-- наводка °
local top = 1

function outer()
  local inner = function() end
  return inner
end

function helper() end
`;

  let host: HTMLDivElement;
  let ready = $state(false);
  // Which file the Structure panel outlines (the lab's stand-in for the
  // workbench's active file); null stands in for "no file open".
  let path = $state<string | null>(LUA_PATH);

  // Caret readout for the e2e suite: the same debounced cursor store the
  // Structure highlight follows.
  const cursorOffset = $derived(
    lang.cursor?.path === LUA_PATH ? lang.cursor.offset : null,
  );

  onMount(() => {
    let view: EditorView | undefined;
    void (async () => {
      lang.engineStatus = "loading";
      try {
        const provider = providerFor(LUA_PATH);
        if (!provider) throw new Error(`no provider for ${LUA_PATH}`);
        await provider.mount(
          [
            { path: LUA_PATH, text: INITIAL },
            { path: OTHER_PATH, text: OTHER },
          ],
          [],
          "lab",
        );
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
          extensions: [basicSetup, langIntelFor(LUA_PATH)],
        }),
      });
      ready = true;
    })();
    return () => view?.destroy();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="structure-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-engine-status">
    engine: {lang.engineStatus}{ready ? " · editor ready" : ""}
  </div>
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="switch-file"
      onclick={() => (path = path === LUA_PATH ? TEXT_PATH : LUA_PATH)}
    >
      outline: {path ?? "none"}
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="switch-lua"
      onclick={() => (path = path === OTHER_PATH ? LUA_PATH : OTHER_PATH)}
    >
      other lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="close-file"
      onclick={() => (path = null)}
    >
      close file
    </button>
    <span data-testid="cursor-offset"
      >cursor: {cursorOffset ?? "-"}</span
    >
  </div>
  <div class="flex min-h-0 flex-1 gap-2">
    <div
      class="min-h-0 min-w-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
      data-testid="lab-editor"
      bind:this={host}
    ></div>
    <div class="w-64 shrink-0 overflow-auto rounded border">
      <Structure {path} />
    </div>
  </div>
</div>
