<script lang="ts">
  // Browser test surface for the IDE's editor-function keymap (line ops,
  // issue #18): a bare CodeMirror wired with the same extensions the real
  // editor uses for these commands — basicSetup, the Lua mode (for the `--`
  // commentTokens toggle-comment reads), and our owned `editorCommands` keymap.
  // No engine, no Tauri: the Playwright suite (e2e-lang/editor-line-ops.spec.ts)
  // seeds known Lua text, drives keystrokes, and reads the document back.
  //
  // It also carries `baseKeymapShadow` — a decoy that makes those specs actually
  // guard `editorCommands` rather than basicSetup's identical defaults. See its
  // declaration; without it the suite is vacuous (review of !21).
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { EditorState } from "@codemirror/state";
  import { keymap } from "@codemirror/view";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { editorCommands } from "$lib/editor/commands";
  import {
    formatKeymap,
    formatterFacet,
    type Formatter,
  } from "$lib/editor/format";

  // Three plain statements: line ops reorder/duplicate/comment them with no
  // dependence on a syntax tree, so the assertions are exact.
  const INITIAL = "local a = 1\nlocal b = 2\nlocal c = 3\n";

  // Ownership guard. basicSetup's `defaultKeymap` already binds these five keys
  // to the same command fns as `editorCommands`, so on its own the suite would
  // stay green even if `editorCommands` were deleted — it would silently fall
  // through to the library default, leaving the "owned, survives a base-setup
  // change" contract unexercised.
  //
  // This decoy stands in for a base setup whose binding for these keys does NOT
  // perform the line op: `swallow` claims the key (returns true → the keymap
  // stops) but edits nothing. CodeMirror runs a key's commands in precedence
  // order, then source order within a precedence, first truthy result winning
  // (@codemirror/view buildKeymap/runHandlers). So:
  //   - `editorCommands` is Prec.high → its real op runs first → the op fires.
  //   - Remove `editorCommands` and this decoy (default precedence, placed
  //     before basicSetup → earlier in source order) wins over basicSetup's real
  //     `defaultKeymap` → swallow runs → no edit → every line-op spec goes red.
  // That red is the proof the suite guards the owned keymap. Keep this decoy
  // ahead of basicSetup; reordering it after basicSetup re-vacuates the suite.
  const swallow = () => true;
  const baseKeymapShadow = keymap.of([
    { key: "Mod-/", run: swallow },
    { key: "Alt-ArrowUp", run: swallow },
    { key: "Alt-ArrowDown", run: swallow },
    { key: "Shift-Alt-ArrowUp", run: swallow },
    { key: "Shift-Alt-ArrowDown", run: swallow },
  ]);

  let host: HTMLDivElement;
  let docText = $state(INITIAL);
  let ready = $state(false);

  // The real formatter runs in Rust behind the `format_source` Tauri command —
  // unreachable from this plain browser. A deterministic stub stands in so the
  // suite can drive the Shift-Alt-F wiring (key → range → applied result): it
  // records the range it was handed ("doc" for a whole-document format, else
  // "from,to") and collapses runs of spaces as a recognisable transform. The
  // engine's actual formatting and range-scoping are proven in Rust
  // (crates/app/src/format.rs); this exercises only the editor integration.
  let formatRange = $state("-");
  const stubFormatter: Formatter = async (text, range) => {
    formatRange = range ? `${range.from},${range.to}` : "doc";
    return { text: text.replace(/ {2,}/g, " "), guard_tripped: false };
  };

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: INITIAL,
        extensions: [
          baseKeymapShadow,
          basicSetup,
          StreamLanguage.define(lua),
          editorCommands,
          // Format Document / Selection (Shift-Alt-F), backed by the stub.
          // Shift-Alt-F is not a basicSetup default, so removing formatKeymap
          // makes the key inert and the format specs go red — no decoy needed.
          formatKeymap,
          formatterFacet.of(stubFormatter),
          EditorView.updateListener.of((u) => {
            docText = u.state.doc.toString();
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
  <div class="shrink-0 text-xs text-muted-foreground" data-testid="format-range">
    {formatRange}
  </div>
</div>
