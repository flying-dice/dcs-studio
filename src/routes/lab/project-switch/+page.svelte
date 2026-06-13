<script lang="ts">
  // Browser test surface for the project switch/close guard (issue #25):
  // the real AppState, real EditorTabs strip, and the real Editor with its
  // file reader pointed at an in-memory store — plus buttons that drive the
  // REAL app.openPath / app.closeProject, their Tauri-touching collaborators
  // swapped for in-memory stand-ins through the ProjectOps seam (same
  // convention as IntelFs in /lab/mount). So the e2e-lang suite can prove
  // that switching/closing with dirty tabs prompts once with the count and
  // that declining aborts everything (model/studio/core.pds
  // DecliningProjectSwitchKeepsEverything).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  const FILES = new Map<string, string>([
    ["proj-a/a.lua", 'print("alpha")\n'],
    ["proj-a/b.lua", 'print("beta")\n'],
  ]);

  let ready = $state(false);

  async function readFile(path: string) {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    // FileLoad-shaped now (issue #30 merged from main): these fixtures are text.
    return { kind: "text" as const, text };
  }

  onMount(() => {
    void (async () => {
      // Swap openPath/closeProject's environment seams for in-memory
      // stand-ins: basename is the last path segment; the workspace mount
      // is a no-op because the lab mounts its files into the engine
      // directly below, like /lab/buffers.
      app.projectOps = {
        basename: async (path) => path.split("/").pop() ?? path,
        mountWorkspace: async () => {},
        resetWorkspace: () => lang.reset(),
      };
      // Mount the lab files into the real wasm engine so the editor's
      // lang-intel pump has a live session (same setup as /lab/lua).
      lang.engineStatus = "loading";
      try {
        const provider = providerFor("proj-a/a.lua");
        if (!provider) throw new Error("no provider for proj-a/a.lua");
        await provider.mount(
          [...FILES].map(([path, text]) => ({ path, text })),
          [],
          "proj-a",
        );
        lang.engineStatus = "ready";
      } catch (error) {
        console.error("language engine failed to mount:", error);
        lang.engineStatus = "failed";
      }
      // The initial open: no tabs yet, so the guard must stay silent.
      await app.openPath("/work/proj-a");
      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="project-switch-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "loading"} · root: {app.rootName || "(none)"} · tabs:
    {app.openFiles.length} · active: {app.fileName || "(none)"} · dirty: {app.dirty}
  </div>
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-a"
      onclick={() => app.openFile("proj-a/a.lua", "a.lua")}
    >
      open a.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="open-b"
      onclick={() => app.openFile("proj-a/b.lua", "b.lua")}
    >
      open b.lua
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="switch-project"
      onclick={() => void app.openPath("/work/proj-b")}
    >
      switch project
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="close-project"
      onclick={() => void app.closeProject()}
    >
      close project
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
