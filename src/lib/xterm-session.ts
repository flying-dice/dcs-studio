// XtermSession — one xterm terminal bound to a backend PTY session, lifted out
// of Terminal.svelte (model/studio/term.pds, issue #13): the WebGL renderer
// lifecycle, the base64 replay/byte-offset splice that merges a remount's
// replayed buffer with the live stream (model ReplayThenLiveOnRemount),
// scrollback search, ResizeObserver fit, and the PTY subscribe/teardown. The
// view renders the tab strip and delegates here; the only component coupling —
// the find overlay — is inverted into the `XtermSessionCallbacks` the component
// supplies, so this controller closes over no component scope and the
// replay/splice wiring is exercisable on its own.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as Xterm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { openExternal } from "$lib/external";
import { termWrite, termResize, termReplay, type TermData } from "$lib/api";
import { OutputSplicer, decodeBase64 } from "$lib/terminalSplice";
import { type EditorTheme } from "$lib/themes";

/** The view's hooks into the find overlay, so the controller drives find
 *  without closing over component state. */
export interface XtermSessionCallbacks {
  /** Ctrl/Cmd+F in the terminal — open the find overlay. */
  onRequestFind(): void;
  /** Escape in the terminal — close the find overlay if it's open; returns true
   *  when it was (so Escape is consumed rather than reaching the shell). */
  onEscape(): boolean;
}

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

/** One xterm + its backend session wiring. Created by Terminal.svelte's
 *  `mountSession` action when a tab's host mounts; torn down on unmount (tab
 *  close or panel collapse), leaving the Rust-side session alive for replay on
 *  remount. */
export class XtermSession {
  private node: HTMLDivElement;
  private id: string;
  private term: Xterm;
  private fitAddon = new FitAddon();
  // GPU renderer. Without a non-DOM renderer xterm falls back to its DOM
  // renderer, where `customGlyphs` does NOT apply — box-drawing/block glyphs
  // are drawn from the font and tile into broken "dashes" (issue: TUIs like
  // Claude Code). WebGL (customGlyphs default true) draws them as continuous
  // lines. Null if the context can't be created/was lost — xterm then degrades
  // to the DOM renderer, still functional.
  private webgl: WebglAddon | null = null;
  // Find-in-buffer over the scrollback; driven by the find overlay.
  private searchAddon = new SearchAddon();
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

  constructor(
    node: HTMLDivElement,
    id: string,
    theme: EditorTheme,
    private readonly callbacks: XtermSessionCallbacks,
  ) {
    this.node = node;
    this.id = id;
    this.term = new Xterm({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      // Required by Unicode11Addon (term.unicode.activeVersion) and the search
      // addon's match decorations — both use xterm's proposed API.
      allowProposedApi: true,
      theme: xtermTheme(theme),
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    // URLs in output (agent links, dev servers, docs) become clickable and
    // open in the OS browser rather than navigating the webview out of the app.
    this.term.loadAddon(new WebLinksAddon((_event, uri) => void openExternal(uri)));
    // Unicode 11 grapheme widths — correct columns for emoji and wide/CJK
    // glyphs that modern TUIs (Claude Code) emit; the default Unicode 6 tables
    // mis-measure them and drift the cursor.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.open(node);
    this.loadWebgl();
    this.term.onData((data) => void termWrite(this.id, data));
    // Ctrl/Cmd+F opens the find overlay instead of reaching the shell; Esc
    // closes it. Returning false keeps the key out of the PTY.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key === "f") {
        this.callbacks.onRequestFind();
        return false;
      }
      if (e.type === "keydown" && e.key === "Escape" && this.callbacks.onEscape()) {
        return false;
      }
      return true;
    });
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(node);
    void this.start();
    this.fit();
  }

  /** Mount the WebGL renderer (must run after `term.open`, which attaches the
   *  element it needs). On context loss, dispose it so xterm falls back to its
   *  DOM renderer rather than rendering against a dead context; if construction
   *  fails outright, the DOM renderer stays — degraded glyphs, still usable. */
  private loadWebgl(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = null;
      });
      this.term.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      this.webgl = null;
    }
  }

  /** Find `query` in the scrollback, moving to the next (or previous) match and
   *  highlighting hits. An empty query clears the highlight. */
  search(query: string, forward: boolean): void {
    if (this.disposed) return;
    if (!query) {
      this.searchAddon.clearDecorations();
      return;
    }
    const opts = {
      decorations: {
        matchBackground: "#5f5f00",
        matchOverviewRuler: "#5f5f00",
        activeMatchBackground: "#af8700",
        activeMatchColorOverviewRuler: "#af8700",
      },
    };
    if (forward) this.searchAddon.findNext(query, opts);
    else this.searchAddon.findPrevious(query, opts);
  }

  clearSearch(): void {
    if (!this.disposed) this.searchAddon.clearDecorations();
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
    this.webgl?.dispose();
    this.term.dispose();
  }
}
