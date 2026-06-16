<script lang="ts">
  // The Marketplace storefront (model studio::market, issue #10): a standalone
  // full-screen store for discovering dcs-studio mods on GitHub. Browsing is
  // GATED — signed out shows a sign-in wall; signed in, discovery searches the
  // `dcs-studio` topic as the logged-in user and renders a card grid with
  // client-side search, tag filter, and sort. Install/download is a later slice.
  import { goto } from "$app/navigation";
  import { marketplace } from "$lib/marketplace.svelte";
  import { app } from "$lib/state.svelte";
  import GithubAuth from "$lib/components/GithubAuth.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import {
    ArrowLeft,
    RefreshCw,
    Search,
    Star,
    Tag,
    ExternalLink,
    UserRound,
    Lock,
    LoaderCircle,
  } from "@lucide/svelte";

  let query = $state("");
  let activeTag = $state<string>("");
  let sort = $state<"stars" | "name">("stars");

  // Discover once signed in; re-run automatically if the user signs in while the
  // wall is up. A still-fresh backend cache makes this cheap.
  $effect(() => {
    if (app.session && !marketplace.loaded && !marketplace.busy) {
      void marketplace.discover(false);
    }
  });

  const allTags = $derived(
    Array.from(new Set(marketplace.listings.flatMap((m) => m.labels))).sort(),
  );

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const xs = marketplace.listings.filter((m) => {
      if (activeTag && !m.labels.includes(activeTag)) return false;
      if (!q) return true;
      return (
        m.name.toLowerCase().includes(q) ||
        m.author.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.labels.some((l) => l.toLowerCase().includes(q))
      );
    });
    return [...xs].sort((a, b) =>
      sort === "stars" ? b.stars - a.stars : a.name.localeCompare(b.name),
    );
  });
</script>

<div class="flex h-screen flex-col bg-background text-foreground" data-testid="marketplace">
  <!-- ── Top bar ── -->
  <header class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
    <Button
      variant="ghost"
      size="icon-sm"
      title="Back"
      onclick={() => goto("/")}
      data-testid="market-back"
    >
      <ArrowLeft class="size-4" />
    </Button>
    <div class="flex items-baseline gap-2">
      <span class="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">DCS&nbsp;Studio</span>
      <span class="text-sm font-medium">Marketplace</span>
    </div>
    <div class="ml-auto">
      {#if app.session}
        <GithubAuth />
      {/if}
    </div>
  </header>

  {#if !app.session}
    <!-- ── Sign-in wall ── -->
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center" data-testid="market-wall">
      <div class="flex size-12 items-center justify-center rounded-full border border-border bg-card">
        <Lock class="size-5 text-muted-foreground" />
      </div>
      <div class="max-w-sm">
        <h2 class="text-base font-medium">Sign in to browse the Marketplace</h2>
        <p class="mt-1 text-[13px] text-muted-foreground">
          The Marketplace discovers community mods from GitHub. Sign in with your GitHub
          account to browse — it's free and uses your account only to search.
        </p>
      </div>
      <!-- The header chip's modal drives the sign-in; on success the store loads. -->
      <GithubAuth />
    </div>
  {:else}
    <!-- ── Toolbar: search · tag · sort · refresh ── -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:value={query}
          placeholder="Search mods…"
          spellcheck="false"
          autocomplete="off"
          class="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:ring-1 focus:ring-ring"
          data-testid="market-search"
        />
      </div>
      <select
        bind:value={activeTag}
        aria-label="Filter by tag"
        class="rounded-md border border-input bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-ring"
        data-testid="market-tag"
      >
        <option value="">All tags</option>
        {#each allTags as t (t)}
          <option value={t}>{t}</option>
        {/each}
      </select>
      <select
        bind:value={sort}
        aria-label="Sort"
        class="rounded-md border border-input bg-background px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-ring"
        data-testid="market-sort"
      >
        <option value="stars">Most stars</option>
        <option value="name">Name</option>
      </select>
      <Button
        variant="outline"
        size="sm"
        class="gap-1.5"
        disabled={marketplace.busy}
        onclick={() => marketplace.discover(true)}
        data-testid="market-refresh"
      >
        <RefreshCw class={marketplace.busy ? "size-3.5 animate-spin" : "size-3.5"} />
        Refresh
      </Button>
    </div>

    {#if marketplace.error}
      <div class="border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive" data-testid="market-error">
        {marketplace.error}
      </div>
    {/if}

    <!-- ── Card grid ── -->
    <ScrollArea class="min-h-0 flex-1">
      {#if marketplace.busy && !marketplace.loaded}
        <div class="flex items-center justify-center gap-2 py-20 text-[13px] text-muted-foreground">
          <LoaderCircle class="size-4 animate-spin" /> Searching GitHub…
        </div>
      {:else if filtered.length === 0}
        <div class="px-6 py-20 text-center text-[13px] text-muted-foreground" data-testid="market-empty">
          {#if marketplace.listings.length === 0}
            No mods found. Publish one by tagging your GitHub repo
            <span class="font-mono">dcs-studio</span>.
          {:else}
            No mods match your search.
          {/if}
        </div>
      {:else}
        <div class="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {#each filtered as mod (mod.repo)}
            <div class="flex flex-col rounded-xl border border-border bg-card p-3 transition-colors hover:border-foreground/30" data-testid="market-card">
              <!-- Header + blurb open the product page. -->
              <button
                class="flex flex-col gap-2 text-left"
                onclick={() => goto(`/marketplace/${mod.repo}`)}
                data-testid="market-card-open"
              >
                <span class="flex items-start gap-2.5">
                  {#if mod.avatar_url}
                    <img src={mod.avatar_url} alt="" class="size-9 shrink-0 rounded-md" />
                  {:else}
                    <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      <UserRound class="size-4 text-muted-foreground" />
                    </span>
                  {/if}
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-[13px] font-medium" title={mod.name}>{mod.name}</span>
                    <span class="block truncate font-mono text-[10px] text-muted-foreground">by {mod.author}</span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground" title="Stars">
                    <Star class="size-3" />{mod.stars}
                  </span>
                </span>
                {#if mod.description}
                  <span class="line-clamp-3 text-[12px] leading-snug text-muted-foreground">{mod.description}</span>
                {/if}
              </button>

              {#if mod.labels.length > 0}
                <div class="mt-2 flex flex-wrap gap-1">
                  {#each mod.labels.slice(0, 6) as label (label)}
                    <button
                      class="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                      title={`Filter by ${label}`}
                      onclick={() => (activeTag = label)}
                    >
                      <Tag class="size-2.5" />{label}
                    </button>
                  {/each}
                </div>
              {/if}

              <div class="mt-3 flex items-center justify-between border-t border-border pt-2">
                <button
                  class="text-[11px] text-foreground hover:text-muted-foreground"
                  onclick={() => goto(`/marketplace/${mod.repo}`)}
                >
                  Details
                </button>
                <a
                  href={mod.repo_url}
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  data-testid="market-repo-link"
                >
                  GitHub <ExternalLink class="size-3" />
                </a>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </ScrollArea>
  {/if}
</div>
