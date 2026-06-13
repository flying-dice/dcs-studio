<script lang="ts">
  // Browser test surface for the Todos panel (issue #16): the real
  // TodoScanner store with an injected in-memory scanner, the real Todos
  // component, and the real Editor — so the e2e-lang suite can assert
  // file grouping, tag chips, click-to-navigate (a real caret reveal),
  // the save-time per-file splice, and the manual refresh — no Tauri,
  // no DCS (model/studio/todos.pds SavedFileRefreshesItsTodos,
  // TodoClickNavigatesEditor).
  import { onMount } from "svelte";
  import { app } from "$lib/state.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import EditorTabs from "$lib/components/EditorTabs.svelte";
  import Todos from "$lib/components/Todos.svelte";
  import { TodoScanner, type TodoEntry, type TodoScanFns } from "$lib/todos.svelte";
  import { lang } from "$lib/lang/intel.svelte";
  import { providerFor } from "$lib/lang/registry";

  // The multibyte prefix on alpha's FIXME line makes byte and UTF-16
  // columns diverge — navigation only lands on the tag if columns count
  // UTF-16 code units end to end.
  const FILES = new Map<string, string>([
    [
      "lab/alpha.lua",
      '-- TODO: wire alpha gauge\nprint("alpha")\n-- цель — FIXME: refit alpha sensor\n',
    ],
    [
      "lab/beta.lua",
      '-- TODO: beta first pass\nprint("beta")\n-- HACK: beta workaround\n',
    ],
  ]);

  // The same matching rule as dcs-studio-project::todos, over the
  // in-memory map: case-sensitive, word-bounded, earliest tag per line,
  // 1-based UTF-16 column (JS string indices are UTF-16 natively).
  function scanText(path: string, text: string, tags: string[]): TodoEntry[] {
    const entries: TodoEntry[] = [];
    text.split("\n").forEach((line, i) => {
      let best: { start: number; tag: string } | null = null;
      for (const tag of tags) {
        const m = new RegExp(`(?<![A-Za-z0-9_])${tag}(?![A-Za-z0-9_])`).exec(line);
        if (m && (best === null || m.index < best.start)) {
          best = { start: m.index, tag };
        }
      }
      if (best) {
        entries.push({
          path,
          line: i + 1,
          column: best.start + 1,
          tag: best.tag,
          text: line
            .slice(best.start + best.tag.length)
            .replace(/^[:\s]+/, "")
            .trimEnd(),
        });
      }
    });
    return entries;
  }

  const scanner: TodoScanFns = {
    scan: async (_root, tags) =>
      [...FILES].flatMap(([path, text]) => scanText(path, text, tags)),
    scanFile: async (path, tags) => scanText(path, FILES.get(path) ?? "", tags),
  };
  const store = new TodoScanner(scanner);

  async function readFile(path: string) {
    const text = FILES.get(path);
    if (text === undefined) throw new Error(`no lab file: ${path}`);
    // FileLoad-shaped now (issue #30 merged from main): these fixtures are text.
    return { kind: "text" as const, text };
  }

  /** Stand-in for the workbench save hook (state.svelte.ts saveFile):
   * write the new content "to disk", then the per-file rescan. */
  function saveBetaRewritten() {
    FILES.set("lab/beta.lua", '-- XXX: beta rewritten\nprint("beta v2")\n');
    void store.refreshFile("lab/beta.lua");
  }

  /** Mutate the workspace WITHOUT any refresh — only the manual refresh
   * button should surface this entry. */
  function growAlpha() {
    FILES.set(
      "lab/alpha.lua",
      `${FILES.get("lab/alpha.lua") ?? ""}-- TODO: alpha grew offline\n`,
    );
  }

  let ready = $state(false);

  onMount(() => {
    void (async () => {
      // Mount the lab files into the real wasm engine so the editor's
      // lang-intel pump (and its caret readout) has a live session.
      lang.engineStatus = "loading";
      try {
        const provider = providerFor("lab/alpha.lua");
        if (!provider) throw new Error("no provider for lab/alpha.lua");
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
      await store.refreshAll("lab");
      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="todos-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-status">
    {ready ? "ready" : "loading"} · engine: {lang.engineStatus} · active:
    {app.fileName || "(none)"}
  </div>
  <div class="flex items-center gap-2 text-xs">
    <button
      class="rounded border px-2 py-0.5"
      data-testid="save-beta"
      onclick={saveBetaRewritten}
    >
      rewrite beta &amp; save
    </button>
    <button class="rounded border px-2 py-0.5" data-testid="grow-alpha" onclick={growAlpha}>
      grow alpha (no refresh)
    </button>
    <span data-testid="lab-cursor"
      >cursor: {lang.cursor ? `${lang.cursor.path}:${lang.cursor.offset}` : "-"}</span
    >
  </div>
  <div class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto rounded border px-2">
    <EditorTabs />
  </div>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div
      class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
      data-testid="lab-editor"
    >
      {#if app.filePath}
        <Editor {readFile} />
      {/if}
    </div>
    <div class="h-56 shrink-0 overflow-hidden rounded border">
      <Todos {store} />
    </div>
  </div>
</div>
