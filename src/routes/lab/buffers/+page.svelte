<script lang="ts">
  // Browser test surface for per-open-file editor buffers (issue #21): the
  // real AppState tab model, real EditorTabs strip, and the real Editor
  // component with its file reader pointed at an in-memory store — so the
  // e2e-lang suite can reproduce the cross-file undo corruption without
  // Tauri or DCS (model/studio/core.pds UndoNeverCrossesFiles,
  // TabSwitchKeepsUnsavedEdits).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  const FILES = new Map<string, string>([
    ["lab/a.lua", 'print("hello")\n'],
    ["lab/b.lua", 'print("world")\n'],
    ["lab/c.lua", 'print("third")\n'],
  ]);

  let ready = $state(false);

  // One-shot hold on the next read of b.lua: the race spec arms it, opens
  // b (read parks in flight), switches back to a, then releases — making
  // the stale-read window deterministic instead of timing-dependent
  // (model StaleLoadNeverHijacksView / LoadTab superseded guard).
  let holdNextB = false;
  let releaseB = $state<(() => void) | null>(null);

  async function readFile(path: string): Promise<string> {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    if (holdNextB && path === "lab/b.lua") {
      holdNextB = false;
      await new Promise<void>((resolve) => {
        releaseB = () => {
          releaseB = null;
          resolve();
        };
      });
    }
    return text;
  }

  onMount(() => {
    void (async () => {
      // Mount the lab files into the real wasm engine so the editor's
      // lang-intel pump has a live session (same setup as /lab/lua).
      lang.engineStatus = "loading";
      try {
        const provider = providerFor("lab/a.lua");
        if (!provider) throw new Error("no provider for lab/a.lua");
        await provider.mount(
          [...FILES].map(([path, text]) => ({ path, text })),
          [],
          "lab",
        );
        lang.engineStatus = "ready";
      } catch (error) {
        console.error("language engine failed to mount:", error);
        lang.engineStatus = "failed";
      }
      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="buffers-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "loading"} · active: {app.fileName || "(none)"} · dirty:
    {app.dirty}
  </div>
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-a"
      onclick={() => app.openFile("lab/a.lua", "a.lua")}
    >
      open a.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-b"
      onclick={() => app.openFile("lab/b.lua", "b.lua")}
    >
      open b.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-c"
      onclick={() => app.openFile("lab/c.lua", "c.lua")}
    >
      open c.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="close-active"
      onclick={() => app.closeActiveFile()}
    >
      close active
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="hold-next-b"
      onclick={() => (holdNextB = true)}
    >
      hold next b read
    </button>
    <button
      class="rounded border px-2 py-0.5 disabled:opacity-40"
      data-testid="release-b"
      disabled={!releaseB}
      onclick={() => releaseB?.()}
    >
      release b read
    </button>
  </div>
  <div class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto rounded border px-2">
    <EditorTabs />
  </div>
  <div
    class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
    data-testid="lab-editor"
  >
    {#if app.filePath}
      <Editor {readFile} />
    {/if}
  </div>
</div>
