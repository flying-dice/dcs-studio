<script lang="ts">
  // Browser test surface for the engine refactorings (issue #18): mounts the
  // REAL lua-analyzer provider over two Lua files and exposes its
  // definition / references / rename queries, so the Playwright suite
  // (e2e-lang/refactor.spec.ts) validates the whole frontend path — provider
  // → LSP → lsp-wire conversion — against the real binary. No workbench tab
  // machinery: the queries are exercised directly, like /lab/lsp.
  import { onMount } from "svelte";
  import { providerFor } from "$lib/lang/registry";
  import { lang } from "$lib/lang/intel.svelte";
  import { app } from "$lib/state.svelte";
  import { renameSymbol } from "$lib/editor/refactor";
  import type { LanguageProvider } from "$lib/lang/provider";

  const LIB = "C:\\dcs-studio-lab\\refactor\\lib.lua";
  const MAIN = "C:\\dcs-studio-lab\\refactor\\main.lua";
  // `shared` is declared in lib.lua (its name starts at byte 9) and used twice
  // in main.lua (the first use starts at byte 0).
  const LIB_SRC = "function shared()\nend\n";
  const MAIN_SRC = "shared()\nshared()\n";

  let ready = $state(false);
  let result = $state("");
  let errorText = $state("");
  let provider: LanguageProvider | null = null;

  onMount(() => {
    void (async () => {
      lang.engineStatus = "loading";
      try {
        provider = providerFor(MAIN);
        if (!provider) throw new Error(`no provider for ${MAIN}`);
        await provider.mount(
          [
            { path: LIB, text: LIB_SRC },
            { path: MAIN, text: MAIN_SRC },
          ],
          [],
          "lab",
        );
        await provider.setSource(LIB, LIB_SRC);
        await provider.setSource(MAIN, MAIN_SRC);
        lang.engineStatus = "ready";
        ready = true;
      } catch (error) {
        console.error("refactor lab mount failed:", error);
        lang.engineStatus = "failed";
      }
    })();
  });

  async function runDefinition() {
    errorText = "";
    result = JSON.stringify(await provider?.definition(MAIN, 0));
  }

  async function runReferences() {
    errorText = "";
    result = JSON.stringify(await provider?.references?.(MAIN, 0));
  }

  async function runRename(name: string) {
    errorText = "";
    result = "";
    try {
      result = JSON.stringify(await provider?.rename?.(MAIN, 0, name));
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }

  // Drive the editor-side rename (model RenameSymbol) with an affected file
  // left DIRTY: the dirty-buffer guard must refuse before any edit is applied
  // (model RenameRefusesWithUnsavedAffectedFiles). MAIN is an affected file
  // (it holds two uses); opening it and editing its buffer makes it dirty.
  async function runEditorRenameDirty() {
    errorText = "";
    result = "";
    app.openFile(MAIN, "main.lua");
    app.onDocEdited(MAIN, `${MAIN_SRC}-- dirty\n`);
    try {
      const count = await renameSymbol(MAIN, 0, "renamed");
      result = `applied ${count}`;
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="refactor-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    engine: {lang.engineStatus}{ready ? " · ready" : ""}
  </div>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <button class="rounded border px-2 py-0.5" data-testid="run-definition" onclick={runDefinition}>
      definition
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="run-references" onclick={runReferences}>
      references
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="run-rename"
      onclick={() => runRename("renamed")}
    >
      rename → renamed
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="run-rename-invalid"
      onclick={() => runRename("1bad")}
    >
      rename → 1bad
    </button>
    <button
      class="rounded border px-2 py-0.5"
      data-testid="run-rename-dirty"
      onclick={runEditorRenameDirty}
    >
      editor rename (dirty affected)
    </button>
  </div>
  <pre class="shrink-0 overflow-auto rounded border p-2 text-xs" data-testid="result">{result}</pre>
  <pre class="shrink-0 overflow-auto rounded border p-2 text-xs" data-testid="error">{errorText}</pre>
</div>
