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
  import { editorCommands } from "$lib/editor/commands";

  // Injectable file reader so /lab/buffers can drive the real per-tab buffer
  // machinery from a plain browser (no Tauri fs) — same seam convention as
  // IntelFs in intel.svelte.ts.
  let {
    readFile = readTextFile,
  }: { readFile?: (path: string) => Promise<string> } = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;

  // Per-open-file editor states (model `ActivateTab`): each tab owns a whole
  // EditorState — doc, undo history, selection, folds — parked here while
  // another tab is active. Tab switches swap states with `view.setState`;
  // another file's text is never spliced into the current state via a
  // transaction, so undo can never resurrect a different file's content.
  const parkedStates = new Map<string, EditorState>();
  const parkedScroll = new Map<string, number>();
  // The path whose state the view currently shows (null = blank).
  let shownPath: string | null = null;
  // Invalidates in-flight first-open reads when the user switches again.
  let loadSeq = 0;

  const themeComp = new Compartment();
  const langComp = new Compartment();
  // Language intelligence (diagnostics, folding, hover) from the embedded
  // engine — baked into each tab's state alongside its syntax mode.
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

  /**
   * A fresh, history-free state for a first-opened file. The update
   * listener closes over the tab's own path, so edits are always reported
   * against the file they were typed into — even mid tab switch.
   */
  function freshState(path: string, name: string, text: string): EditorState {
    return EditorState.create({
      doc: text,
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
          if (u.docChanged) {
            app.onDocEdited(path, u.state.doc.toString());
          }
        }),
        // The IDE's editor-function keymap (toggle comment, move/duplicate
        // line) — an owned, documented contract, not a basicSetup default.
        editorCommands,
        themeComp.of(app.cm),
        langComp.of(languageFor(name)),
        langIntelComp.of(langIntelFor(path)),
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { fontFamily: "var(--font-mono)" },
        }),
      ],
    });
  }

  /** Park the shown tab's state + scroll, unless its tab was closed. */
  function parkCurrent() {
    if (!view || shownPath === null) return;
    const stillOpen = app.openFiles.some((f) => f.path === shownPath);
    if (!stillOpen) return;
    parkedStates.set(shownPath, view.state);
    parkedScroll.set(shownPath, view.scrollDOM.scrollTop);
  }

  /** Land the caret on a Problems-click location, once, and focus. */
  function applyPendingJump() {
    if (!view) return;
    const jump = app.pendingJump;
    if (!jump) return;
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

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "" }),
    });
    return () => view?.destroy();
  });

  // Swap whole per-file states when the active tab changes; drop parked
  // states for closed tabs (so reopening reloads from disk, model `RemoveTab`).
  $effect(() => {
    const path = app.activePath;
    const doc = app.activeDoc;
    const open = new Set(app.openFiles.map((f) => f.path));
    for (const parked of Array.from(parkedStates.keys())) {
      if (!open.has(parked)) {
        parkedStates.delete(parked);
        parkedScroll.delete(parked);
      }
    }
    if (!view) return;
    // Every run invalidates older in-flight first-open reads — including
    // runs that land on the already-shown tab. Switching BACK to the shown
    // file while another file's read is in flight must defuse that read,
    // or it would resolve later and hijack the view (tab strip says A,
    // buffer shows B; model `LoadTab` superseded guard).
    const seq = ++loadSeq;
    if (path === shownPath) return;
    if (!path || !doc) {
      parkCurrent();
      shownPath = null;
      view.setState(EditorState.create({ doc: "" }));
      return;
    }
    const parked = parkedStates.get(path);
    if (parked) {
      // Tab switch back: the parked state carries the tab's pending edits,
      // undo history, selection, and folds untouched.
      parkCurrent();
      shownPath = path;
      view.setState(parked);
      // Restore scroll after the swapped-in state has been measured/laid
      // out, not synchronously against stale geometry.
      const scrollTop = parkedScroll.get(path) ?? 0;
      view.requestMeasure({
        read: () => null,
        write: () => {
          if (view && shownPath === path) view.scrollDOM.scrollTop = scrollTop;
        },
      });
      // The parked state may predate a theme change — re-sync it.
      view.dispatch({ effects: themeComp.reconfigure(app.cm) });
      applyPendingJump();
      return;
    }
    // First activation: load from disk into a fresh state (model `LoadTab`).
    // Fresh states are inherently history-free, so the load itself is never
    // undoable.
    const name = doc.name;
    void (async () => {
      let text: string;
      try {
        text = await readFile(path);
      } catch (error) {
        // Failed read (model `LoadTab` Err arm): never leave an empty tab
        // impersonating the file on disk — close it, unless the load was
        // superseded (same guard as the success arm: a newer switch owns the
        // tab strip, or this tab is no longer the active one). No toast
        // surface exists yet; log like the other fs/engine failures.
        console.error(`failed to read ${path}:`, error);
        if (seq === loadSeq && app.activePath === path) void app.closeFile(path);
        return;
      }
      // Superseded while in flight (newer switch, or the tab was closed and
      // a neighbour activated) — the stale text must not win the view.
      if (!view || seq !== loadSeq || app.activePath !== path) return;
      parkCurrent();
      shownPath = path;
      view.setState(freshState(path, name, text));
      app.onDocLoaded(path, text);
      applyPendingJump();
    })();
  });

  // A Problems click on the already-active file changes only pendingJump.
  $effect(() => {
    const jump = app.pendingJump;
    if (jump && view && app.activePath === shownPath) applyPendingJump();
  });

  // Live theme swap (affects the shown state; parked states re-sync on swap).
  $effect(() => {
    const cm = app.cm;
    view?.dispatch({ effects: themeComp.reconfigure(cm) });
  });
</script>

<div class="h-full w-full overflow-hidden [&_.cm-editor]:h-full" bind:this={host}></div>
