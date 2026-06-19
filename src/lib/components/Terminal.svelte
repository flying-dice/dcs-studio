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
  import { SvelteMap } from "svelte/reactivity";
  import { app } from "$lib/state.svelte";
  import { terminal } from "$lib/terminal.svelte";
  import { editorThemeById } from "$lib/themes";
  import { XtermSession } from "$lib/xterm-session";
  import { cn } from "$lib/utils.js";
  import { Plus, X, SquareTerminal, ArrowUp, ArrowDown } from "@lucide/svelte";
  import { onMount } from "svelte";

  // Resolve the detected-shell profile the first time the panel opens.
  onMount(() => void terminal.init());

  // Live xterm controllers, keyed by session id. A reactive map so the
  // active-tab effect re-runs once a session's control is created by the
  // action (the effect would otherwise miss the freshly opened tab's focus).
  const controls = new SvelteMap<string, XtermSession>();
  let pickerOpen = $state(false);

  // Find-in-buffer overlay, driving the active session's search addon.
  let findOpen = $state(false);
  let findQuery = $state("");

  /** The currently visible session, or null when there are no tabs. */
  function activeSession(): XtermSession | undefined {
    return terminal.activeId ? controls.get(terminal.activeId) : undefined;
  }

  /** Focus + select the find input the moment it mounts (the overlay only
   *  renders while open, so mounting coincides with opening). */
  function focusFind(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function openFind(): void {
    findOpen = true;
    if (findQuery) activeSession()?.search(findQuery, true);
  }

  function closeFind(): void {
    findOpen = false;
    activeSession()?.clearSearch();
    activeSession()?.focus();
  }

  /** Re-run the search against the active session; `forward` steps match order. */
  function runFind(forward: boolean): void {
    activeSession()?.search(findQuery, forward);
  }

  /** Svelte action: stand up an xterm for `id` on this host div, tear it down
   *  when the div unmounts. */
  function mountSession(node: HTMLDivElement, id: string) {
    const session = new XtermSession(node, id, editorThemeById(app.editorThemeId), {
      onRequestFind: () => openFind(),
      onEscape: () => {
        if (!findOpen) return false;
        closeFind();
        return true;
      },
    });
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

  // Re-fit once a session's backend pty is registered. The constructor's fit
  // races ahead of `termSpawn` and its resize is dropped (the session isn't
  // live yet), so the child stays at the 80-col spawn default until now. Fit
  // every live session, not just the latest: two spawns can share one flush,
  // and fit is idempotent — hidden tabs (size 0) no-op.
  $effect(() => {
    terminal.spawnGeneration;
    for (const session of controls.values()) session.fit();
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
      {#if findOpen && terminal.tabs.length > 0}
        <!-- Find-in-buffer overlay (Ctrl/Cmd+F). Enter = next, Shift+Enter =
             previous, Esc = close. -->
        <div
          class="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-md border border-border bg-popover px-1.5 py-1 shadow-md"
          data-testid="terminal-find"
        >
          <input
            use:focusFind
            bind:value={findQuery}
            type="text"
            placeholder="Find"
            class="h-6 w-40 bg-transparent px-1 text-[11px] text-popover-foreground outline-none placeholder:text-muted-foreground"
            oninput={() => runFind(true)}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runFind(!e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeFind();
              }
            }}
          />
          <button
            type="button"
            class="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            onclick={() => runFind(false)}
          >
            <ArrowUp class="size-3.5" />
          </button>
          <button
            type="button"
            class="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Next match (Enter)"
            aria-label="Next match"
            onclick={() => runFind(true)}
          >
            <ArrowDown class="size-3.5" />
          </button>
          <button
            type="button"
            class="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close find"
            onclick={closeFind}
          >
            <X class="size-3.5" />
          </button>
        </div>
      {/if}
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
