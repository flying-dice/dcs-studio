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
  import FileTree from "$lib/components/FileTree.svelte";

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
        // A nested folder so the suite can prove a refresh preserves expanded
        // subfolders (the keyed-each reconciliation, not a teardown).
        await createDir(root, root, "sub");
        await writeTextFile(join(join(root, "sub"), "nested.lua"), "local n = 3\n");
        app.rootPath = root;
        app.openFile(aPath, "a.lua");
        // Focus-neutral refresh hook: the real SWR poll bumps treeVersion on a
        // timer (no focus change). A test that clicks a button to refresh would
        // instead blur an open create box (its click-away commit), so drive the
        // refresh through this hook to mimic the poll faithfully.
        (window as unknown as { __refreshTree__?: () => void }).__refreshTree__ = () =>
          app.refreshTree();
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
      data-testid="rename-background"
      onclick={() =>
        act(async () => {
          // a.lua active, b.lua a background tab: renaming the background file
          // must NOT steal focus from a.lua (model RetargetTabs).
          app.openFile(bPath, "b.lua");
          app.activateFile(aPath);
          await app.renameWorkspacePath(root, bPath, cPath);
        })}
    >
      rename background b→c (a active)
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
    <button
      class="rounded border px-2 py-0.5"
      data-testid="refresh-tree"
      onclick={() => app.refreshTree()}
    >
      refresh tree
    </button>
    <!-- Stands in for the surrounding IDE (editor, panels) that steals focus the
         moment a tree box opens — the genuine-UI condition the lab otherwise
         lacks. A test focuses this to prove the box does NOT close on blur. -->
    <input class="rounded border px-2 py-0.5" data-testid="focus-thief" placeholder="thief" />
  </div>
  <div class="text-xs" data-testid="open-files">{openNames}</div>
  <div class="text-xs" data-testid="active-file">{activeName}</div>
  <pre class="shrink-0 overflow-auto rounded border p-2 text-xs" data-testid="error">{errorText}</pre>
  <!-- The REAL FileTree component, so the suite can drive its context menus
       (per-node + root/empty-space) end to end. Sized so there is empty space
       below the seeded nodes to right-click. -->
  <div class="h-64 w-72 overflow-auto rounded border" data-testid="tree-host">
    <FileTree />
  </div>
</div>
