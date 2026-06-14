<script lang="ts">
  // Integrated terminal tool window (model/studio/term.pds, issue #13): tabbed
  // pseudo-terminal sessions with launch profiles, rendered in the bottom
  // stripe's "Terminal" slot.
  //
  // Each tab owns one xterm bound to a backend PTY session. The session lives
  // in `terminal` (terminal.svelte.ts), so it survives this component
  // unmounting when the panel collapses; on (re)mount each xterm replays its
  // buffer and then streams live, spliced by byte offset so the boundary
  // neither gaps nor repeats (model ReplayThenLiveOnRemount).
  import { isTauri } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { SvelteMap } from "svelte/reactivity";
  import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { app } from "$lib/state.svelte";
  import { terminal } from "$lib/terminal.svelte";
  import { editorThemeById, type EditorTheme } from "$lib/themes";
  import { termWrite, termResize, termReplay, type TermData } from "$lib/api";
  import { OutputSplicer, decodeBase64 } from "$lib/terminalSplice";
  import { cn } from "$lib/utils.js";
  import { Plus, X, SquareTerminal } from "@lucide/svelte";
  import { onMount } from "svelte";

  // Resolve the detected-shell profile the first time the panel opens.
  onMount(() => void terminal.init());

  /** Map an editor theme onto xterm's palette so the terminal matches the IDE. */
  function xtermTheme(theme: EditorTheme): ITheme {
    return {
      background: theme.bg,
      foreground: theme.fg,
      cursor: theme.accent,
      cursorAccent: theme.bg,
      selectionBackground: theme.selection,
    };
  }

  /** One xterm + its backend session wiring. Created by the `mountSession`
   *  action when a tab's host mounts; torn down on unmount (tab close or panel
   *  collapse), leaving the Rust-side session alive for replay on remount. */
  class XtermSession {
    private node: HTMLDivElement;
    private id: string;
    private term: Xterm;
    private fitAddon = new FitAddon();
    private observer: ResizeObserver;
    private unlistenData: UnlistenFn | null = null;
    private disposed = false;
    // Splice state: the cursor tracks the highest byte offset already written so
    // a replayed tail and the live chunks queued during replay merge without a
    // gap or a repeat; `pending` holds live chunks that arrive before the replay
    // is written.
    private splicer = new OutputSplicer();
    private replayed = false;
    private pending: TermData[] = [];

    constructor(node: HTMLDivElement, id: string, theme: EditorTheme) {
      this.node = node;
      this.id = id;
      this.term = new Xterm({
        fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
        fontSize: 12,
        cursorBlink: true,
        scrollback: 5000,
        theme: xtermTheme(theme),
      });
      this.term.loadAddon(this.fitAddon);
      this.term.open(node);
      this.term.onData((data) => void termWrite(this.id, data));
      this.observer = new ResizeObserver(() => this.fit());
      this.observer.observe(node);
      void this.start();
      this.fit();
    }

    /** Subscribe to live output, then replay the buffer and flush anything that
     *  arrived meanwhile. Order matters: subscribe FIRST (so nothing is missed),
     *  queue until the replay is written, then splice by offset. */
    private async start(): Promise<void> {
      const unlisten = await listen<TermData>(`term://data/${this.id}`, (event) =>
        this.onData(event.payload),
      );
      if (this.disposed) {
        unlisten();
        return;
      }
      this.unlistenData = unlisten;
      const snapshot = await termReplay(this.id);
      if (this.disposed) return;
      this.writeChunk(snapshot.data, snapshot.seq);
      for (const chunk of this.pending) this.writeChunk(chunk.data, chunk.seq);
      this.pending = [];
      this.replayed = true;
    }

    private onData(chunk: TermData): void {
      if (this.replayed) this.writeChunk(chunk.data, chunk.seq);
      else this.pending.push(chunk);
    }

    /** Decode a base64 output chunk and write only the part past what the splice
     *  cursor has already shown — the replayed tail and the live stream merge
     *  without a gap or a repeat (model ReplayThenLiveOnRemount). */
    private writeChunk(data: string, seq: number): void {
      if (this.disposed) return;
      const slice = this.splicer.next(decodeBase64(data), seq);
      if (slice && slice.length > 0) this.term.write(slice);
    }

    /** Fit to the host and push the new size to the PTY — but only when the host
     *  is actually visible (an inactive tab is `display:none`, size 0). */
    fit(): void {
      if (this.disposed || !this.node.clientWidth || !this.node.clientHeight) return;
      try {
        this.fitAddon.fit();
      } catch {
        return;
      }
      void termResize(this.id, this.term.rows, this.term.cols);
    }

    focus(): void {
      if (!this.disposed) this.term.focus();
    }

    setTheme(theme: EditorTheme): void {
      if (!this.disposed) this.term.options.theme = xtermTheme(theme);
    }

    dispose(): void {
      this.disposed = true;
      this.observer.disconnect();
      this.unlistenData?.();
      this.term.dispose();
    }
  }

  // Live xterm controllers, keyed by session id. A reactive map so the
  // active-tab effect re-runs once a session's control is created by the
  // action (the effect would otherwise miss the freshly opened tab's focus).
  const controls = new SvelteMap<string, XtermSession>();
  let pickerOpen = $state(false);

  /** Svelte action: stand up an xterm for `id` on this host div, tear it down
   *  when the div unmounts. */
  function mountSession(node: HTMLDivElement, id: string) {
    const session = new XtermSession(node, id, editorThemeById(app.editorThemeId));
    controls.set(id, session);
    return {
      destroy() {
        controls.delete(id);
        session.dispose();
      },
    };
  }

  // Re-theme every live terminal when the editor theme changes.
  $effect(() => {
    const theme = editorThemeById(app.editorThemeId);
    for (const session of controls.values()) session.setTheme(theme);
  });

  // When the active tab changes, fit + focus the newly shown terminal (it was
  // display:none, so it never fitted while hidden). Runs after the DOM updates.
  $effect(() => {
    const id = terminal.activeId;
    if (!id) return;
    const session = controls.get(id);
    if (session) {
      session.fit();
      session.focus();
    }
  });

  function openProfile(id: string): void {
    pickerOpen = false;
    void terminal.open(id);
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="terminal-panel">
  {#if !isTauri()}
    <!-- Plain browser (vite dev, Playwright): no PTY backend. -->
    <div class="flex h-full items-center justify-center px-4 text-center">
      <p class="text-[11px] tracking-wide text-muted-foreground">
        The integrated terminal requires the desktop app.
      </p>
    </div>
  {:else}
    <!-- Tab strip + new-session picker. -->
    <div class="relative flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      {#each terminal.tabs as tab (tab.id)}
        <div
          class={cn(
            "group flex h-7 items-center gap-1 rounded-md pl-2 pr-1 text-[11px] tracking-wide",
            tab.id === terminal.activeId
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60",
          )}
          data-testid="terminal-tab"
        >
          <button
            type="button"
            class="flex items-center gap-1.5"
            title={tab.label}
            onclick={() => terminal.setActive(tab.id)}
          >
            <SquareTerminal class="size-3 shrink-0" />
            <span class="max-w-32 truncate">{tab.label}</span>
          </button>
          <button
            type="button"
            class="rounded p-0.5 opacity-0 hover:bg-muted-foreground/20 group-hover:opacity-100"
            title="Close session"
            aria-label="Close session"
            data-testid="terminal-close"
            onclick={() => void terminal.close(tab.id)}
          >
            <X class="size-3" />
          </button>
        </div>
      {/each}

      <button
        type="button"
        class="ml-1 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
        title="New terminal session"
        aria-label="New terminal session"
        data-testid="terminal-new"
        onclick={() => (pickerOpen = !pickerOpen)}
      >
        <Plus class="size-3.5" />
      </button>

      {#if pickerOpen}
        <!-- Profile picker: detected shell, harnesses, then user-defined. -->
        <div
          class="absolute left-2 top-9 z-20 min-w-44 rounded-md border border-border bg-popover py-1 shadow-md"
          data-testid="terminal-profiles"
        >
          {#each terminal.profiles as profile (profile.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] tracking-wide text-popover-foreground hover:bg-secondary"
              onclick={() => openProfile(profile.id)}
            >
              <SquareTerminal class="size-3 shrink-0 text-muted-foreground" />
              <span class="truncate">{profile.label}</span>
            </button>
          {/each}
        </div>
        <!-- Click-away closes the picker. -->
        <button
          type="button"
          class="fixed inset-0 z-10 cursor-default"
          aria-label="Close profile picker"
          tabindex="-1"
          onclick={() => (pickerOpen = false)}
        ></button>
      {/if}
    </div>

    <!-- Session area: one stacked host per tab, only the active one shown. -->
    <div class="relative min-h-0 flex-1">
      {#if terminal.tabs.length === 0}
        <div class="flex h-full items-center justify-center px-4 text-center">
          <p class="text-[11px] tracking-wide text-muted-foreground">
            No sessions. Click <span class="font-mono">+</span> to launch a shell or an agentic harness.
          </p>
        </div>
      {/if}
      {#each terminal.tabs as tab (tab.id)}
        <div
          class={cn("absolute inset-0", tab.id !== terminal.activeId && "hidden")}
        >
          {#if tab.error}
            <div class="flex h-full items-center justify-center px-4 text-center">
              <p class="font-mono text-[11px] text-destructive">
                Could not start "{tab.label}": {tab.error}
              </p>
            </div>
          {:else}
            <div class="h-full w-full p-1" use:mountSession={tab.id}></div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
