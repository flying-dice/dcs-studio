<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { keymap } from "@codemirror/view";
  import { EditorState, Compartment, type Extension } from "@codemirror/state";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { toml } from "@codemirror/legacy-modes/mode/toml";
  import { json } from "@codemirror/lang-json";
  import { markdown } from "@codemirror/lang-markdown";
  import { rust } from "@codemirror/lang-rust";
  import { app } from "$lib/state.svelte";
  import { readTextFile } from "$lib/api";
  import { langIntelFor } from "$lib/lang/codemirror";

  let host: HTMLDivElement;
  let view: EditorView | undefined;

  // Set while we programmatically replace the document (file load / close) so
  // the change listener doesn't mistake the load for a user edit.
  let loadingDoc = false;

  const themeComp = new Compartment();
  const langComp = new Compartment();
  // Language intelligence (diagnostics, folding, hover) from the embedded
  // engine — reconfigured per file alongside the syntax mode.
  const langIntelComp = new Compartment();

  function languageFor(name: string): Extension {
    const n = name.toLowerCase();
    if (n.endsWith(".lua")) return StreamLanguage.define(lua);
    if (n.endsWith(".rs")) return rust();
    if (n.endsWith(".toml")) return StreamLanguage.define(toml);
    if (n.endsWith(".json")) return json();
    if (n.endsWith(".md") || n.endsWith(".markdown")) return markdown();
    return [];
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                void app.saveFile();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !loadingDoc) {
              app.onDocEdited(u.state.doc.toString());
            }
          }),
          themeComp.of(app.cm),
          langComp.of([]),
          langIntelComp.of([]),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: "var(--font-mono)" },
          }),
        ],
      }),
    });
    return () => view?.destroy();
  });

  // Load file contents + language when the active file changes.
  $effect(() => {
    const path = app.filePath;
    const name = app.fileName;
    if (!view) return;
    if (!path) {
      loadingDoc = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "" },
        effects: langIntelComp.reconfigure([]),
      });
      loadingDoc = false;
      return;
    }
    readTextFile(path).then((text) => {
      if (!view) return;
      loadingDoc = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: [
          langComp.reconfigure(languageFor(name)),
          langIntelComp.reconfigure(langIntelFor(path)),
        ],
      });
      loadingDoc = false;
      app.onDocLoaded(text);
      // A Problems click carries its finding's location: land the caret
      // there and bring it into view.
      const jump = app.pendingJump;
      if (jump) {
        app.pendingJump = null;
        const line = view.state.doc.line(
          Math.min(Math.max(jump.line, 1), view.state.doc.lines),
        );
        const offset = Math.min(line.from + Math.max(jump.col - 1, 0), line.to);
        view.dispatch({
          selection: { anchor: offset },
          effects: EditorView.scrollIntoView(offset, { y: "center" }),
        });
        view.focus();
      }
    });
  });

  // Live theme swap.
  $effect(() => {
    const cm = app.cm;
    view?.dispatch({ effects: themeComp.reconfigure(cm) });
  });
</script>

<div class="h-full w-full overflow-hidden [&_.cm-editor]:h-full" bind:this={host}></div>
