<script lang="ts">
  // Browser test surface for the Bookmarks panel (issue #58): the real
  // `bookmarks` store, the real Bookmarks component, and the real Editor with
  // its bookmark gutter — so the flow can be exercised without Tauri or DCS.
  // Mark a line from the gutter and it appears in the panel; click a panel row
  // and the editor caret reveals it; type lines above a mark (a real CodeMirror
  // edit) and save, and the mark re-anchors to its code
  // (model/studio/bookmarks.pds BookmarkSurvivesEditsWhileOpen,
  // BookmarkClickNavigatesEditor). The gutter is bound to the app-wide store,
  // so the lab drives that singleton (not an injected one).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import Bookmarks from "$lib/components/Bookmarks.svelte";
  import { bookmarks } from "$lib/bookmarks.svelte";

  const FILES = new Map<string, string>([
    ["lab/alpha.lua", '-- alpha\nlocal function start()\n  print("alpha")\nend\nreturn start\n'],
    ["lab/beta.lua", '-- beta\nlocal spawns = {}\nreturn spawns\n'],
  ]);

  async function readFile(path: string) {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    return { kind: "text" as const, text };
  }

  let ready = $state(false);

  onMount(() => {
    // In-memory writer so the real save path (app.saveFile → on-save
    // re-anchor) runs without a Tauri fs.
    app.writeFile = async (path, contents) => {
      FILES.set(path, contents);
    };
    bookmarks.load("lab");
    app.openFile("lab/alpha.lua", "alpha.lua");
    ready = true;
    return () => bookmarks.reset();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="bookmarks-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "loading"} · active: {app.fileName || "(none)"} · marks:
    {bookmarks.entries.length}
  </div>
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <span>Click the gutter to mark a line. Type above a mark, then</span>
    <button class="rounded border px-2 py-0.5" data-testid="save" onclick={() => app.saveFile()}>
      save
    </button>
    <span>to re-anchor it.</span>
  </div>
  <div class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto rounded border px-2">
    <EditorTabs />
  </div>
  <div class="flex min-h-0 flex-1 gap-2">
    <div
      class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
      data-testid="lab-editor"
    >
      {#if app.filePath}
        <Editor {readFile} />
      {/if}
    </div>
    <div class="w-72 shrink-0 overflow-hidden rounded border">
      <Bookmarks />
    </div>
  </div>
</div>
