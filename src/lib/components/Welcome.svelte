<script lang="ts">
  import { goto } from "$app/navigation";
  import { app } from "$lib/state.svelte";
  import { pickFolder, pathExists } from "$lib/api";
  import { TEMPLATES } from "$lib/templates";
  import { EDITOR_THEMES, editorThemeById } from "$lib/themes";
  import { cn } from "$lib/utils.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import { copyPath } from "$lib/tree-actions";

  import {
    Boxes,
    FolderOpen,
    Plus,
    ShoppingCart,
    ArrowRight,
    Sun,
    Moon,
    X,
    FolderClosed,
    ChevronRight,
    LoaderCircle,
    Folder,
    Palette,
  } from "@lucide/svelte";

  const darkThemes = EDITOR_THEMES.filter((t) => t.dark);
  const lightThemes = EDITOR_THEMES.filter((t) => !t.dark);
  const editorThemeLabel = $derived(editorThemeById(app.editorThemeId).label);

  // ── New-project form state ──────────────────────────────────────────────
  let mode = $state<"idle" | "new">("idle");
  let templateId = $state(TEMPLATES[0].id);
  let name = $state("");
  let location = $state<string | null>(null);
  let creating = $state(false);
  let error = $state<string | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);

  const sep = $derived(location?.includes("\\") ? "\\" : "/");
  const canCreate = $derived(
    !!name.trim() && !!location && !creating,
  );
  const previewPath = $derived(
    location && name.trim() ? `${location}${sep}${name.trim()}` : null,
  );

  function startNew() {
    mode = "new";
    error = null;
    queueMicrotask(() => nameInput?.focus());
  }

  function cancelNew() {
    mode = "idle";
    name = "";
    location = null;
    error = null;
  }

  async function chooseLocation() {
    const picked = await pickFolder();
    if (picked) location = picked;
  }

  async function create() {
    if (!canCreate || !location) return;
    creating = true;
    error = null;
    try {
      await app.createProject(location, name.trim(), templateId);
      // On success the app swaps to the IDE; nothing more to do here.
    } catch (e) {
      error = String(e);
      creating = false;
    }
  }

  // ── Recent projects ─────────────────────────────────────────────────────
  // Flag entries whose folder no longer exists on disk. Outside Tauri (plain
  // vite dev) pathExists rejects — treat those as present so nothing greys out.
  let missing = $state<Set<string>>(new Set());
  $effect(() => {
    const paths = app.recents.map((r) => r.path);
    Promise.all(
      paths.map(async (p) => {
        try {
          return [p, await pathExists(p)] as const;
        } catch {
          return [p, true] as const;
        }
      }),
    ).then((results) => {
      missing = new Set(results.filter(([, ok]) => !ok).map(([p]) => p));
    });
  });

  function ago(ts: number): string {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(mo / 12)}y ago`;
  }

  function openRecent(path: string) {
    if (missing.has(path)) return;
    // Fire-and-forget (closeFile convention): openPath's own `switching`
    // guard keeps a double-click from running the flow twice.
    void app.openPath(path);
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  function onKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) {
      if (e.key === "Escape" && mode === "new") cancelNew();
      return;
    }
    if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      startNew();
    } else if (e.key.toLowerCase() === "o") {
      e.preventDefault();
      app.openFolder();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="welcome relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
  <!-- ── Atmosphere: blueprint grid · glow · registration ticks ── -->
  <div class="grid-bg pointer-events-none absolute inset-0"></div>
  <div class="glow pointer-events-none absolute inset-0"></div>
  <div class="pointer-events-none absolute inset-5 z-10">
    <span class="tick absolute left-0 top-0 border-l border-t"></span>
    <span class="tick absolute right-0 top-0 border-r border-t"></span>
    <span class="tick absolute bottom-0 left-0 border-b border-l"></span>
    <span class="tick absolute bottom-0 right-0 border-b border-r"></span>
  </div>

  <!-- ── Top frame: brand · mode toggle ── -->
  <header class="reveal relative z-20 flex shrink-0 select-none items-center justify-between px-8 pt-7" style="--d:0ms">
    <div class="flex items-center gap-2">
      <Boxes class="size-4 text-foreground" />
      <span class="font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
        DCS&nbsp;Studio
      </span>
    </div>
    <div class="flex items-center gap-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              class="flex items-center gap-2 rounded-md px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Palette class="size-3.5" />
              {editorThemeLabel}
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="min-w-44">
          <DropdownMenu.RadioGroup
            value={app.editorThemeId}
            onValueChange={(v) => app.setEditorTheme(v)}
          >
            <DropdownMenu.Label class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Dark
            </DropdownMenu.Label>
            {#each darkThemes as t (t.id)}
              <DropdownMenu.RadioItem value={t.id}>{t.label}</DropdownMenu.RadioItem>
            {/each}
            <DropdownMenu.Separator />
            <DropdownMenu.Label class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Light
            </DropdownMenu.Label>
            {#each lightThemes as t (t.id)}
              <DropdownMenu.RadioItem value={t.id}>{t.label}</DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground"
        aria-label="Toggle light/dark"
        onclick={() => app.toggleMode()}
      >
        {#if app.dark}<Sun />{:else}<Moon />{/if}
      </Button>
    </div>
  </header>

  <!-- ── Body: hero · recents ── -->
  <main class="relative z-20 grid min-h-0 flex-1 grid-cols-1 content-center gap-x-16 gap-y-12 px-8 py-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-16">
    <!-- HERO -->
    <section class="flex min-w-0 flex-col justify-center">
      <span class="reveal mb-5 font-mono text-[11px] uppercase tracking-[0.34em] text-muted-foreground" style="--d:60ms">
        ⟢ Project Launcher
      </span>

      <h1 class="reveal flex items-baseline gap-3 leading-none" style="--d:120ms">
        <span class="font-mono text-6xl font-bold tracking-tighter">dcs</span>
        <span class="font-mono text-6xl font-light tracking-tighter text-muted-foreground">studio</span>
      </h1>

      <p class="reveal mt-5 max-w-md text-sm leading-relaxed text-muted-foreground" style="--d:180ms">
        Author, manage, and package Digital Combat Simulator mods. Start from a
        template or open existing work.
      </p>

      <!-- Actions / New-project form -->
      <div class="reveal mt-9 max-w-md" style="--d:240ms">
        {#if mode === "idle"}
          <div class="flex flex-col gap-3">
            <button class="action group" onclick={startNew}>
              <span class="action-icon"><Plus class="size-[18px]" /></span>
              <span class="flex min-w-0 flex-col items-start">
                <span class="text-sm font-medium text-foreground">New Project</span>
                <span class="text-[12px] text-muted-foreground">Scaffold from a template</span>
              </span>
              <kbd class="kbd ml-auto">⌘N</kbd>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>

            <button class="action group" onclick={() => app.openFolder()}>
              <span class="action-icon"><FolderOpen class="size-[18px]" /></span>
              <span class="flex min-w-0 flex-col items-start">
                <span class="text-sm font-medium text-foreground">Open Project</span>
                <span class="text-[12px] text-muted-foreground">Open an existing folder</span>
              </span>
              <kbd class="kbd ml-auto">⌘O</kbd>
              <ChevronRight class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>

            <button class="action group" onclick={() => goto("/marketplace")} data-testid="welcome-marketplace">
              <span class="action-icon"><ShoppingCart class="size-[18px]" /></span>
              <span class="flex min-w-0 flex-col items-start">
                <span class="text-sm font-medium text-foreground">Marketplace</span>
                <span class="text-[12px] text-muted-foreground">Browse community mods</span>
              </span>
              <ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        {:else}
          <div class="rounded-xl border border-border bg-card/60 p-4 backdrop-blur-sm">
            <div class="mb-3 flex items-center justify-between">
              <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                New Project
              </span>
              <button class="text-muted-foreground hover:text-foreground" aria-label="Cancel" onclick={cancelNew}>
                <X class="size-4" />
              </button>
            </div>

            <!-- Template tiles -->
            <div class="grid grid-cols-2 gap-2">
              {#each TEMPLATES as t (t.id)}
                {@const Icon = t.icon}
                <button
                  class={cn(
                    "tmpl flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
                    templateId === t.id
                      ? "border-foreground/40 bg-accent/60 ring-1 ring-foreground/15"
                      : "border-border hover:bg-accent/40",
                  )}
                  onclick={() => (templateId = t.id)}
                >
                  <Icon class={cn("size-4", templateId === t.id ? "text-foreground" : "text-muted-foreground")} />
                  <span class="text-[13px] font-medium text-foreground">{t.label}</span>
                  <span class="text-[11px] leading-snug text-muted-foreground">{t.description}</span>
                </button>
              {/each}
            </div>

            <!-- Name -->
            <label class="mt-3 block">
              <span class="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Name</span>
              <input
                bind:this={nameInput}
                bind:value={name}
                onkeydown={(e) => e.key === "Enter" && create()}
                placeholder="my-script-mod"
                spellcheck="false"
                autocomplete="off"
                class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring"
              />
            </label>

            <!-- Location -->
            <div class="mt-3">
              <span class="mb-1 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Location</span>
              <button
                class="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm hover:bg-accent/40"
                onclick={chooseLocation}
              >
                <Folder class="size-4 shrink-0 text-muted-foreground" />
                <span class={cn("truncate", location ? "text-foreground" : "text-muted-foreground/70")}>
                  {location ?? "Choose location…"}
                </span>
              </button>
              {#if previewPath}
                <p class="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                  → {previewPath}
                </p>
              {/if}
            </div>

            {#if error}
              <p class="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </p>
            {/if}

            <div class="mt-4 flex items-center gap-2">
              <Button class="flex-1" disabled={!canCreate} onclick={create}>
                {#if creating}
                  <LoaderCircle class="animate-spin" />Creating…
                {:else}
                  Create Project<ArrowRight />
                {/if}
              </Button>
              <Button variant="ghost" onclick={cancelNew}>Cancel</Button>
            </div>
          </div>
        {/if}
      </div>
    </section>

    <!-- RECENTS -->
    <section class="reveal flex min-w-0 flex-col" style="--d:300ms">
      <div class="mb-3 flex items-center justify-between">
        <span class="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Recent Projects
        </span>
        {#if app.recents.length}
          <span class="font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {String(app.recents.length).padStart(2, "0")}
          </span>
        {/if}
      </div>

      {#if app.recents.length === 0}
        <div class="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 py-14 text-center">
          <FolderClosed class="size-6 text-muted-foreground/50" />
          <p class="text-[13px] text-muted-foreground">No recent projects</p>
          <p class="max-w-[15rem] text-[11px] text-muted-foreground/70">
            Projects you create or open will appear here.
          </p>
        </div>
      {:else}
        <ul class="flex flex-col">
          {#each app.recents as r, i (r.path)}
            {@const gone = missing.has(r.path)}
            <li>
              <ContextMenu.Root>
              <ContextMenu.Trigger class="block">
              <div
                class={cn(
                  "recent group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors",
                  gone ? "opacity-45" : "hover:bg-accent/50",
                )}
              >
                <span class="font-mono text-[11px] tabular-nums text-muted-foreground/50">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <button
                  class="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-not-allowed"
                  disabled={gone}
                  onclick={() => openRecent(r.path)}
                >
                  <span class="flex w-full items-center gap-2">
                    <span class="truncate text-[13px] font-medium text-foreground">{r.name}</span>
                    {#if gone}
                      <span class="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-destructive">missing</span>
                    {/if}
                  </span>
                  <span class="w-full truncate font-mono text-[11px] text-muted-foreground">{r.path}</span>
                </button>
                <span class="shrink-0 font-mono text-[10px] text-muted-foreground/60 group-hover:opacity-0">
                  {ago(r.openedAt)}
                </span>
                <button
                  class="absolute right-2.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  aria-label="Remove from recents"
                  onclick={() => app.removeRecent(r.path)}
                >
                  <X class="size-3.5" />
                </button>
              </div>
              </ContextMenu.Trigger>
              <ContextMenu.Content class="w-48" data-testid="recent-context-menu">
                <ContextMenu.Item disabled={gone} onSelect={() => openRecent(r.path)}>
                  Open
                </ContextMenu.Item>
                <ContextMenu.Item onSelect={() => app.removeRecent(r.path)}>
                  Remove from recents
                </ContextMenu.Item>
                <ContextMenu.Item onSelect={() => copyPath(r.path)}>Copy Path</ContextMenu.Item>
              </ContextMenu.Content>
              </ContextMenu.Root>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </main>

  <!-- ── Bottom frame ── -->
  <footer class="reveal relative z-20 flex shrink-0 items-center justify-between px-8 pb-6 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70" style="--d:360ms">
    <span>v0.1.0</span>
    <span>⌘N new · ⌘O open</span>
  </footer>
</div>

<style>
  /* Blueprint grid, masked to fade toward the edges. */
  .grid-bg {
    background-image:
      linear-gradient(to right, var(--border) 1px, transparent 1px),
      linear-gradient(to bottom, var(--border) 1px, transparent 1px);
    background-size: 46px 46px;
    background-position: center;
    opacity: 0.6;
    -webkit-mask-image: radial-gradient(ellipse 80% 70% at 35% 40%, #000 0%, transparent 75%);
    mask-image: radial-gradient(ellipse 80% 70% at 35% 40%, #000 0%, transparent 75%);
  }

  /* Soft monochrome glow, top-left, anchoring the wordmark. */
  .glow {
    background: radial-gradient(
      circle 480px at 22% 28%,
      color-mix(in oklch, var(--foreground) 9%, transparent),
      transparent 70%
    );
  }

  /* Corner registration ticks. */
  .tick {
    width: 14px;
    height: 14px;
    border-color: var(--muted-foreground);
    opacity: 0.35;
  }

  .action {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    width: 100%;
    padding: 0.75rem 0.875rem;
    border-radius: 0.6rem;
    border: 1px solid var(--border);
    background: color-mix(in oklch, var(--card) 55%, transparent);
    text-align: left;
    cursor: pointer;
    transition:
      border-color 0.18s ease,
      background 0.18s ease,
      transform 0.18s ease;
  }
  .action:hover {
    border-color: color-mix(in oklch, var(--foreground) 28%, transparent);
    background: var(--accent);
    transform: translateY(-1px);
  }
  .action-icon {
    display: grid;
    place-items: center;
    width: 2.1rem;
    height: 2.1rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    border: 1px solid var(--border);
    background: var(--background);
    color: var(--foreground);
  }

  .kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 5px;
    border: 1px solid var(--border);
    color: var(--muted-foreground);
    background: var(--background);
  }

  /* Staggered entrance. */
  .reveal {
    opacity: 0;
    transform: translateY(8px);
    animation: reveal 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    animation-delay: var(--d, 0ms);
  }
  @keyframes reveal {
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reveal {
      animation: none;
      opacity: 1;
      transform: none;
    }
  }
</style>
