<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, basicSetup } from "codemirror";
  import { keymap } from "@codemirror/view";
  import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
  import { StreamLanguage } from "@codemirror/language";
  import { lua } from "@codemirror/legacy-modes/mode/lua";
  import { toml } from "@codemirror/legacy-modes/mode/toml";
  import { json } from "@codemirror/lang-json";
  import { markdown } from "@codemirror/lang-markdown";
  import { rust } from "@codemirror/lang-rust";
  import { app } from "$lib/state.svelte";
  import { classifyAndRead, type FileLoad } from "$lib/api";
  import { errorMessage } from "$lib/utils";
  import { langIntelFor } from "$lib/lang/codemirror";
  import { debuggerExtension, syncDebugView, setConditionHandler } from "$lib/editor/debugger";
  import { debug } from "$lib/debug-session.svelte";
  import { editorCommands } from "$lib/editor/commands";
  import {
    refactorExtensions,
    renameRequestFacet,
    renameSymbol,
    goToDefinition,
    findUsages,
    hasRefactorProvider,
    type RenameRequest,
  } from "$lib/editor/refactor";
  import {
    formatKeymap,
    formatterFacet,
    makeTauriFormatter,
    runFormat,
  } from "$lib/editor/format";
  import { runViewInDcs } from "$lib/lua-console.svelte";
  import { runConfig, isLuaFile } from "$lib/run-config.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import BinaryPlaceholder from "$lib/components/BinaryPlaceholder.svelte";

  // Injectable file reader so /lab/buffers can drive the real per-tab buffer
  // machinery from a plain browser (no Tauri fs) — same seam convention as
  // IntelFs in intel.svelte.ts. Classifies by content (model `ReadFile`): the
  // result is text or a binary marker, never a failed read of binary bytes.
  let {
    readFile = classifyAndRead,
  }: { readFile?: (path: string) => Promise<FileLoad> } = $props();

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
        // Ctrl/Cmd+Enter runs the selection (or whole file) in DCS — the same
        // gesture as the REPL (model RunFile). High-prec so it owns the key.
        Prec.high(
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                runActiveInDcs();
                return true;
              },
            },
          ]),
        ),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            app.onDocEdited(path, u.state.doc.toString());
          }
        }),
        // The IDE's editor-function keymap (toggle comment, move/duplicate
        // line) — an owned, documented contract, not a basicSetup default.
        editorCommands,
        // Format Document / Selection (Shift-Alt-F) over the shared dcs-lua
        // engine, reached through the Tauri command for this tab's file.
        formatKeymap,
        formatterFacet.of(makeTauriFormatter(path)),
        // Engine refactorings: F12 go-to-def, Shift-F12 find-usages, F2 rename
        // (model studio::edit Refactoring); the rename widget renders here.
        refactorExtensions(path),
        renameRequestFacet.of((request) => openRename(path, request)),
        // Breakpoint gutter + current-execution-line highlight (debugger),
        // only for Lua scripts (the only runnable/debuggable files); synced
        // from the debug-session store by the $effect below.
        ...(isLuaFile(path) ? [debuggerExtension(path)] : []),
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

  /** An empty, history-free state — the blank view for no-file and binary tabs. */
  function blankState(): EditorState {
    return EditorState.create({ doc: "" });
  }

  /** Park the shown tab's state + scroll, unless its tab was closed. */
  function parkCurrent() {
    if (!view || shownPath === null) return;
    const stillOpen = app.openFiles.some((f) => f.path === shownPath);
    if (!stillOpen) return;
    parkedStates.set(shownPath, view.state);
    parkedScroll.set(shownPath, view.scrollDOM.scrollTop);
  }

  /** Land the caret on a pending jump (Problems line/col or a go-to-def /
   * usages offset), once, and focus. */
  function applyPendingJump() {
    if (!view) return;
    const jump = app.pendingJump;
    if (!jump) return;
    app.pendingJump = null;
    let offset: number;
    if ("offset" in jump) {
      offset = Math.min(Math.max(jump.offset, 0), view.state.doc.length);
    } else {
      const line = view.state.doc.line(
        Math.min(Math.max(jump.line, 1), view.state.doc.lines),
      );
      offset = Math.min(line.from + Math.max(jump.col - 1, 0), line.to);
    }
    view.dispatch({
      selection: { anchor: offset },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
    view.focus();
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: blankState(),
    });
    // Reformat the active buffer in place for format-on-save; app.saveFile
    // applies it before the write. There is deliberately no editor save
    // binding — the global ⌘S (+page.svelte) is the single save path, so the
    // same keystroke can't both format-then-save here and save unformatted
    // there.
    app.setBufferFormatter(() =>
      view ? runFormat(view, null) : Promise.resolve(),
    );
    // Right-click the breakpoint gutter → open an inline condition editor.
    setConditionHandler((path, line, x, y) => {
      const rect = host.getBoundingClientRect();
      conditionBox = {
        path,
        line,
        value: debug.conditionFor(path, line),
        x: x - rect.left,
        y: y - rect.top,
      };
      queueMicrotask(() => conditionInput?.focus());
    });
    return () => {
      app.setBufferFormatter(null);
      setConditionHandler(null);
      view?.destroy();
    };
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
      view.setState(blankState());
      return;
    }
    // Known-binary fast-path (mirrors the parked fast-path): a re-activated
    // binary tab shows a blank view behind the placeholder overlay — no read,
    // no parked state (model `LoadTab`: binary marks the tab, never `ShowTab`).
    if (doc.kind === "binary") {
      parkCurrent();
      shownPath = path;
      view.setState(blankState());
      return;
    }
    const parked = parkedStates.get(path);
    if (parked) {
      // Tab switch back: the parked state carries the tab's pending edits,
      // undo history, selection, and folds untouched.
      parkCurrent();
      shownPath = path;
      view.setState(parked);
      syncDebugView(view, path);
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
      let load: FileLoad;
      try {
        load = await readFile(path);
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
      // Superseded while in flight (newer switch, or the tab was closed and a
      // neighbour activated) — the stale load must not win the view. The ONE
      // guard covers the binary, text, and (above) failed arms alike.
      if (!view || seq !== loadSeq || app.activePath !== path) return;
      parkCurrent();
      shownPath = path;
      if (load.kind === "binary") {
        // Binary (model `MarkBinary`): a blank view behind the placeholder —
        // the bytes never enter the editor and the tab is never closed.
        view.setState(blankState());
        app.onDocBinary(path, load.size);
        return;
      }
      view.setState(freshState(path, name, load.text));
      syncDebugView(view, path);
      app.onDocLoaded(path, load.text);
      applyPendingJump();
    })();
  });

  // A Problems click on the already-active file changes only pendingJump.
  $effect(() => {
    const jump = app.pendingJump;
    if (jump && view && app.activePath === shownPath) applyPendingJump();
  });

  // A cross-file rename rewrote some inactive tabs on disk: drop their parked
  // state so reactivation reloads the renamed text (model `ApplyWorkspaceEdit`).
  $effect(() => {
    const { paths } = app.evicted;
    for (const p of paths) {
      if (p === shownPath) continue; // the active editor already has the edit
      parkedStates.delete(p);
      parkedScroll.delete(p);
    }
  });

  // Live theme swap (affects the shown state; parked states re-sync on swap).
  $effect(() => {
    const cm = app.cm;
    view?.dispatch({ effects: themeComp.reconfigure(cm) });
  });

  // Keep the active editor's breakpoint gutter + current-execution-line in sync
  // with the debug session. Touch the reactive fields so this re-runs on any
  // breakpoint toggle, pause, or step (and on tab switch via app.filePath).
  $effect(() => {
    const path = app.filePath;
    const deps = [debug.breakpoints, debug.status, debug.frame, debug.topLocals];
    if (view && path && deps) syncDebugView(view, path);
  });

  // The active tab when it's binary — drives the placeholder overlay (model
  // BinaryFileShowsPlaceholder). Null for loading/text tabs.
  const binaryDoc = $derived(
    app.activeDoc?.kind === "binary" ? app.activeDoc : null,
  );

  // Inline rename widget (model studio::edit Refactoring.RenameSymbol): a small
  // floating input over the caret, prefilled with the symbol. Positioned in
  // host-relative pixels from the caret's screen coords.
  let renameBox = $state<{
    path: string;
    offset: number;
    value: string;
    x: number;
    y: number;
    error: string | null;
    busy: boolean;
  } | null>(null);
  let renameInput = $state<HTMLInputElement | undefined>();

  // Inline breakpoint-condition editor (opened from the gutter right-click).
  let conditionBox = $state<{
    path: string;
    line: number;
    value: string;
    x: number;
    y: number;
  } | null>(null);
  let conditionInput = $state<HTMLInputElement | undefined>();

  async function submitCondition() {
    if (!conditionBox) return;
    const { path, line, value } = conditionBox;
    conditionBox = null;
    await debug.setCondition(path, line, value);
    view?.focus();
  }
  function cancelCondition() {
    conditionBox = null;
    view?.focus();
  }

  function openRename(path: string, request: RenameRequest) {
    if (!view) return;
    const coords = view.coordsAtPos(request.offset);
    const rect = host.getBoundingClientRect();
    renameBox = {
      path,
      offset: request.offset,
      value: request.name,
      x: coords ? coords.left - rect.left : 8,
      y: coords ? coords.bottom - rect.top + 4 : 8,
      error: null,
      busy: false,
    };
    // Focus + select so typing replaces the name (VS Code rename UX).
    queueMicrotask(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  async function submitRename() {
    if (!renameBox || renameBox.busy) return;
    const { path, offset, value } = renameBox;
    renameBox = { ...renameBox, busy: true, error: null };
    try {
      await renameSymbol(path, offset, value.trim());
      renameBox = null;
      view?.focus();
    } catch (error) {
      const message = errorMessage(error);
      // Keep the box open showing why, so the developer can fix the name.
      if (renameBox) renameBox = { ...renameBox, busy: false, error: message };
    }
  }

  function cancelRename() {
    renameBox = null;
    view?.focus();
  }

  // ---- editor context menu (issue #17) ------------------------------------
  // Whether the active file has a ready language provider — gates the
  // go-to-definition / find-usages entries.
  const langReady = $derived(hasRefactorProvider(app.filePath));

  function hasSelection(): boolean {
    if (!view) return false;
    const { from, to } = view.state.selection.main;
    return from !== to;
  }

  function copySelection() {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    if (text) void navigator.clipboard?.writeText(text);
  }

  function cutSelection() {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    void navigator.clipboard?.writeText(view.state.sliceDoc(from, to));
    view.dispatch({ changes: { from, to, insert: "" } });
    view.focus();
  }

  async function pasteClipboard() {
    if (!view) return;
    const text = await navigator.clipboard?.readText();
    if (!text) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  function formatDocument() {
    if (view) void runFormat(view, null);
  }

  function formatSelection() {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from !== to) void runFormat(view, { from, to });
  }

  function ctxGoToDefinition() {
    if (view && app.filePath)
      void goToDefinition(app.filePath, view.state.selection.main.head);
  }

  function ctxFindUsages() {
    if (!view || !app.filePath) return;
    const head = view.state.selection.main.head;
    const word = view.state.wordAt(head);
    const symbol = word ? view.state.sliceDoc(word.from, word.to) : "";
    void findUsages(app.filePath, head, symbol);
    app.bottomTool = "usages";
  }

  // Run the selection (or the whole file if nothing is selected) in DCS — the
  // file is the source now that the console is output-only (model RunFile; any
  // file, not just Lua). Shared with the tab-strip Run button via runViewInDcs
  // so the two gestures never diverge.
  function runActiveInDcs() {
    if (view) runViewInDcs(view);
  }
</script>

<div class="relative h-full w-full">
  <ContextMenu.Root>
    <ContextMenu.Trigger class="block h-full w-full">
      <div class="h-full w-full overflow-hidden [&_.cm-editor]:h-full" bind:this={host}></div>
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-60" data-testid="editor-context-menu">
      <ContextMenu.Item disabled={!hasSelection()} onSelect={cutSelection}>Cut</ContextMenu.Item>
      <ContextMenu.Item disabled={!hasSelection()} onSelect={copySelection}>Copy</ContextMenu.Item>
      <ContextMenu.Item onSelect={() => void pasteClipboard()}>Paste</ContextMenu.Item>
      <ContextMenu.Separator />
      <ContextMenu.Item onSelect={formatDocument}>Format Document</ContextMenu.Item>
      <ContextMenu.Item disabled={!hasSelection()} onSelect={formatSelection}>
        Format Selection
      </ContextMenu.Item>
      {#if app.filePath}
        <ContextMenu.Separator />
        <ContextMenu.Item
          disabled={!langReady}
          onSelect={ctxGoToDefinition}
          data-testid="ctx-go-to-definition"
        >
          Go to Definition
        </ContextMenu.Item>
        <ContextMenu.Item
          disabled={!langReady}
          onSelect={ctxFindUsages}
          data-testid="ctx-find-usages"
        >
          Find Usages
        </ContextMenu.Item>
        {#if isLuaFile(app.filePath)}
          <ContextMenu.Separator />
          <ContextMenu.Item
            onSelect={() => app.filePath && runConfig.runFileTarget(app.filePath)}
            data-testid="ctx-run-file"
          >
            Run '{app.fileName}'
          </ContextMenu.Item>
          <ContextMenu.Item
            onSelect={() => app.filePath && runConfig.debugFileTarget(app.filePath)}
            data-testid="ctx-debug-file"
          >
            Debug '{app.fileName}'
          </ContextMenu.Item>
        {/if}
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
  {#if binaryDoc}
    <!-- Opaque placeholder over the blank editor view, JetBrains-Fleet style
         (model BinaryFileShowsPlaceholder). The blank CodeMirror view sits behind. -->
    <BinaryPlaceholder path={binaryDoc.path} size={binaryDoc.binarySize ?? 0} />
  {/if}
  {#if renameBox}
    <!-- Inline rename widget (model studio::edit RenameSymbol). Enter applies,
         Escape cancels; a refusal (invalid name, unsaved affected file) keeps
         it open with the message. -->
    <div
      class="absolute z-20 flex flex-col gap-1"
      style="left: {Math.max(renameBox.x, 4)}px; top: {renameBox.y}px"
      data-testid="rename-widget"
    >
      <input
        bind:this={renameInput}
        bind:value={renameBox.value}
        class="w-48 rounded border border-border bg-popover px-2 py-1 font-mono text-xs shadow-md outline-none ring-1 ring-primary/40"
        data-testid="rename-input"
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitRename();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelRename();
          }
        }}
        onblur={() => cancelRename()}
      />
      {#if renameBox.error}
        <div
          class="w-48 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
          data-testid="rename-error"
        >
          {renameBox.error}
        </div>
      {/if}
    </div>
  {/if}
  {#if conditionBox}
    <!-- Inline breakpoint-condition editor (gutter right-click). Enter saves,
         Escape cancels; an empty value clears the condition. -->
    <div
      class="absolute z-20 flex flex-col gap-0.5"
      style="left: {Math.max(conditionBox.x, 4)}px; top: {conditionBox.y}px"
      data-testid="condition-widget"
    >
      <span class="rounded-t bg-popover px-1.5 text-[10px] text-muted-foreground">
        Breakpoint condition
      </span>
      <input
        bind:this={conditionInput}
        bind:value={conditionBox.value}
        placeholder="e.g. i == 3"
        class="w-56 rounded border border-border bg-popover px-2 py-1 font-mono text-xs shadow-md outline-none ring-1 ring-primary/40"
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitCondition();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelCondition();
          }
        }}
        onblur={() => void submitCondition()}
      />
    </div>
  {/if}
</div>
