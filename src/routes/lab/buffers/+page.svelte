<script lang="ts">
  // Browser test surface for per-open-file editor buffers (issue #21): the
  // real AppState tab model, real EditorTabs strip, and the real Editor
  // component with its file reader pointed at an in-memory store — so the
  // e2e-lang suite can reproduce the cross-file undo corruption without
  // Tauri or DCS (model/studio/core.pds UndoNeverCrossesFiles,
  // TabSwitchKeepsUnsavedEdits, SaveDirtyFile and friends).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import { type FileLoad } from "$lib/api";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  // FileLoad-shaped store (model `ReadFile`): text files carry their contents,
  // bin.dat is a binary marker — so the lab drives the real classify path and
  // the binary placeholder without Tauri.
  const FILES = new Map<string, FileLoad>([
    ["lab/a.lua", { kind: "text", text: 'print("hello")\n' }],
    ["lab/b.lua", { kind: "text", text: 'print("world")\n' }],
    ["lab/c.lua", { kind: "text", text: 'print("third")\n' }],
    ["lab/bin.dat", { kind: "binary", size: 4096 }],
  ]);

  let ready = $state(false);

  // One-shot hold on the next read of b.lua: the race spec arms it, opens
  // b (read parks in flight), switches back to a, then releases — making
  // the stale-read window deterministic instead of timing-dependent
  // (model StaleLoadNeverHijacksView / LoadTab superseded guard).
  let holdNextB = false;
  let releaseB = $state<(() => void) | null>(null);

  async function readFile(path: string): Promise<FileLoad> {
    const load = FILES.get(path);
    if (load === undefined) throw new Error(`no lab file: ${path}`);
    if (holdNextB && path === "lab/b.lua") {
      holdNextB = false;
      await new Promise<void>((resolve) => {
        releaseB = () => {
          releaseB = null;
          resolve();
        };
      });
    }
    return load;
  }

  // In-memory writer behind app.writeFile, with the same one-shot
  // hold/release seam as the reader — the save specs use it to keep a
  // write deterministically in flight while keystrokes land or tabs
  // switch (model SaveFile / MarkSaved capture semantics).
  const writes = $state<{ path: string; text: string }[]>([]);
  let holdNextWrite = false;
  let releaseWrite = $state<(() => void) | null>(null);

  async function writeFile(path: string, contents: string): Promise<void> {
    if (holdNextWrite) {
      holdNextWrite = false;
      await new Promise<void>((resolve) => {
        releaseWrite = () => {
          releaseWrite = null;
          resolve();
        };
      });
    }
    writes.push({ path, text: contents });
  }

  onMount(() => {
    app.writeFile = writeFile;
    void (async () => {
      // Mount the lab files into the real wasm engine so the editor's
      // lang-intel pump has a live session (same setup as /lab/lua).
      lang.engineStatus = "loading";
      try {
        const provider = providerFor("lab/a.lua");
        if (!provider) throw new Error("no provider for lab/a.lua");
        // Mount only the text files into the engine; the binary marker has no
        // contents to index.
        const textFiles = [...FILES].flatMap(([path, load]) =>
          load.kind === "text" ? [{ path, text: load.text }] : [],
        );
        await provider.mount(textFiles, [], "lab");
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
  <div class="text-xs text-muted-foreground" data-testid="lab-writes">
    writes: {writes.length}
    {#each writes as w, i (i)}
      · {w.path} =&gt; {w.text.trim()}
    {/each}
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
      data-testid="open-missing"
      onclick={() => app.openFile("lab/missing.lua", "missing.lua")}
    >
      open missing.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-bin"
      onclick={() => app.openFile("lab/bin.dat", "bin.dat")}
    >
      open bin.dat
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
    <button
      class="rounded border px-2 py-0.5"
      data-testid="hold-next-write"
      onclick={() => (holdNextWrite = true)}
    >
      hold next write
    </button>
    <button
      class="rounded border px-2 py-0.5 disabled:opacity-40"
      data-testid="release-write"
      disabled={!releaseWrite}
      onclick={() => releaseWrite?.()}
    >
      release write
    </button>
  </div>
  <div
    role="tablist"
    aria-label="Open files"
    class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto rounded border px-2"
  >
    <EditorTabs />
  </div>
  <!-- Mirror prod (`routes/+page.svelte`): the Editor is gated behind an open
       file. Closing the last tab unmounts it and shows the no-file
       placeholder — this pins prod's real last-tab-close, not a lab-only
       always-mounted blank editor. While files stay open (tab switches) the
       Editor stays mounted, so the swap-effect lazy-loader is still exercised. -->
  <div
    class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
    data-testid="lab-editor"
  >
    {#if app.filePath}
      <Editor {readFile} />
    {:else}
      <div
        class="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground"
        data-testid="no-file-placeholder"
      >
        Pick a file from the project tree to start editing.
      </div>
    {/if}
  </div>
</div>
