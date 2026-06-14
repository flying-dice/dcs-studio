<script lang="ts">
  // Browser test surface for the file-tree workspace mutations (issue #17):
  // drives the REAL guarded fs commands + the open-tab coordination on `app`
  // (model studio::core RenameWorkspacePath / DeleteWorkspacePath, studio::files
  // WorkspaceFs) against a REAL temp workspace, so the Playwright suite
  // (e2e-lang/tree.spec.ts) validates rename-follow, the dirty-rename refusal,
  // delete-closes-tab, and the collision guard end to end. Needs Tauri fs, so it
  // runs under the real-app CDP suite like the other engine labs.
  import { onMount } from "svelte";
  import { tempDir } from "@tauri-apps/api/path";
  import { createDir, writeTextFile, deleteToTrash } from "$lib/api";
  import { createEntry } from "$lib/tree-actions";
  import { app } from "$lib/state.svelte";

  const DIRNAME = "dcs-tree-lab";
  let ready = $state(false);
  let errorText = $state("");
  let root = "";
  let aPath = "";
  let bPath = "";
  let cPath = "";

  function join(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
  }

  onMount(() => {
    void (async () => {
      try {
        const base = await tempDir();
        root = join(base, DIRNAME);
        aPath = join(root, "a.lua");
        bPath = join(root, "b.lua");
        cPath = join(root, "c.lua");
        // Start from a clean workspace each run (a prior run may have left
        // c.lua / new.lua that would collide).
        try {
          await deleteToTrash(base, root);
        } catch {
          /* nothing to clean */
        }
        await createDir(base, base, DIRNAME);
        await writeTextFile(aPath, "local a = 1\n");
        await writeTextFile(bPath, "local b = 2\n");
        app.rootPath = root;
        app.openFile(aPath, "a.lua");
        ready = true;
      } catch (error) {
        errorText = error instanceof Error ? error.message : String(error);
      }
    })();
  });

  const openNames = $derived(app.openFiles.map((f) => f.name).join(","));
  const activeName = $derived(app.activePath?.split(/[\\/]/).pop() ?? "");

  async function act(fn: () => Promise<void>) {
    errorText = "";
    try {
      await fn();
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="tree-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : errorText ? `error: ${errorText}` : "loading"}
  </div>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="rename-clean"
      onclick={() => act(() => app.renameWorkspacePath(root, aPath, cPath))}
    >
      rename a→c (clean)
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="rename-collision"
      onclick={() => act(() => app.renameWorkspacePath(root, aPath, bPath))}
    >
      rename a→b (collision)
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="rename-dirty"
      onclick={() =>
        act(async () => {
          app.onDocEdited(aPath, "local a = 99\n");
          await app.renameWorkspacePath(root, aPath, cPath);
        })}
    >
      rename a→c (dirty)
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="delete-open"
      onclick={() => act(() => app.deleteWorkspacePath(root, aPath))}
    >
      delete a
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="create-file"
      onclick={() => act(() => createEntry(root, "file", "new.lua"))}
    >
      new file
    </button>
  </div>
  <div class="text-xs" data-testid="open-files">{openNames}</div>
  <div class="text-xs" data-testid="active-file">{activeName}</div>
  <pre class="shrink-0 overflow-auto rounded border p-2 text-xs" data-testid="error">{errorText}</pre>
</div>
