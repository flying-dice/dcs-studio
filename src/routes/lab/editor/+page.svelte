<script lang="ts">
  // Browser test surface for the IDE's editor-function keymap (line/selection
  // ops, issue #18): a bare CodeMirror wired with the same extensions the real
  // editor uses for these commands — basicSetup, the Lua mode (for the `--`
  // commentTokens toggle-comment reads), and our owned `editorCommands` keymap.
  // No engine, no Tauri: the Playwright suite (e2e-lang/editor-line-ops.spec.ts)
  // seeds known Lua text, drives keystrokes, and reads the document back.
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { editorCommands } from "$lib/editor/commands";

  // Three plain statements: line ops reorder/duplicate/comment them with no
  // dependence on a syntax tree, so the assertions are exact.
  const INITIAL = "local a = 1\nlocal b = 2\nlocal c = 3\n";

  let host: HTMLDivElement;
  let docText = $state(INITIAL);
  let selText = $state("");
  let ready = $state(false);

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: INITIAL,
        extensions: [
          basicSetup,
          StreamLanguage.define(lua),
          editorCommands,
          EditorView.updateListener.of((u) => {
            docText = u.state.doc.toString();
            const range = u.state.selection.main;
            selText = u.state.sliceDoc(range.from, range.to);
          }),
        ],
      }),
    });
    ready = true;
    return () => view.destroy();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3" data-testid="editor-lab">
  <div class="text-xs text-muted-foreground" data-testid="lab-ready">
    {ready ? "editor ready" : "loading"}
  </div>
  <div
    class="min-h-0 flex-1 overflow-hidden rounded border [&_.cm-editor]:h-full"
    data-testid="lab-editor"
    bind:this={host}
  ></div>
  <pre
    class="shrink-0 overflow-auto rounded border p-2 text-xs"
    data-testid="doc-text">{docText}</pre>
  <div class="text-xs" data-testid="sel-text">{selText}</div>
</div>
