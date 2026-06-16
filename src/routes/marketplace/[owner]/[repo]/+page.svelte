<script lang="ts">
  // A mod's product page (model studio::market `LoadProduct`, issue #10): the
  // README, the install plan parsed from `dcs-studio.toml` (what installs where),
  // and the download size. Reached from a store card; sign-in gated like the
  // store. Install/download itself is a later slice.
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { marketplace } from "$lib/marketplace.svelte";
  import { app } from "$lib/state.svelte";
  import { renderMarkdown } from "$lib/lang/markdown";
  import GithubAuth from "$lib/components/GithubAuth.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import {
    ArrowLeft,
    Star,
    ExternalLink,
    UserRound,
    Lock,
    LoaderCircle,
    HardDrive,
    FolderInput,
    ArrowRight,
    Package,
    BookOpen,
  } from "@lucide/svelte";

  const owner = $derived($page.params.owner ?? "");
  const repo = $derived($page.params.repo ?? "");
  const product = $derived(marketplace.product);

  // Load (or reload) when the route params change and the user is signed in.
  $effect(() => {
    if (app.session && owner && repo) {
      void marketplace.loadProduct(owner, repo);
    }
  });

  function formatBytes(n: number): string {
    if (n <= 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }
</script>

<div class="flex h-screen flex-col bg-background text-foreground" data-testid="market-product">
  <!-- ── Top bar ── -->
  <header class="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
    <Button variant="ghost" size="icon-sm" title="Back to Marketplace" onclick={() => goto("/marketplace")} data-testid="product-back">
      <ArrowLeft class="size-4" />
    </Button>
    <span class="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">Marketplace</span>
    <div class="ml-auto">
      {#if app.session}<GithubAuth />{/if}
    </div>
  </header>

  {#if !app.session}
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-full border border-border bg-card">
        <Lock class="size-5 text-muted-foreground" />
      </div>
      <h2 class="text-base font-medium">Sign in to view this mod</h2>
      <GithubAuth />
    </div>
  {:else if marketplace.productBusy}
    <div class="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <LoaderCircle class="size-4 animate-spin" /> Loading…
    </div>
  {:else if marketplace.productError}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p class="text-[13px] text-destructive" data-testid="product-error">{marketplace.productError}</p>
      <Button size="sm" variant="outline" onclick={() => marketplace.loadProduct(owner, repo)}>Try again</Button>
    </div>
  {:else if product}
    <ScrollArea class="min-h-0 flex-1">
      <div class="mx-auto grid max-w-5xl grid-cols-1 gap-6 p-6 lg:grid-cols-[1fr_18rem]">
        <!-- ── Main: header + README ── -->
        <main class="min-w-0">
          <div class="flex items-start gap-3">
            {#if product.avatar_url}
              <img src={product.avatar_url} alt="" class="size-12 shrink-0 rounded-lg" />
            {:else}
              <div class="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
                <UserRound class="size-5 text-muted-foreground" />
              </div>
            {/if}
            <div class="min-w-0">
              <h1 class="truncate text-lg font-semibold">{product.name}</h1>
              <div class="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
                <span>by {product.author}</span>
                <span class="flex items-center gap-1"><Star class="size-3" />{product.stars}</span>
                {#if product.release_tag}<span>{product.release_tag}</span>{/if}
              </div>
            </div>
          </div>
          {#if product.description}
            <p class="mt-3 text-[13px] text-muted-foreground">{product.description}</p>
          {/if}

          <!-- README -->
          <div class="mt-6 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <BookOpen class="size-3.5" /> Readme
          </div>
          {#if product.readme}
            <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized by renderMarkdown (DOMPurify) -->
            <div class="readme mt-2 text-[13px] leading-relaxed">{@html renderMarkdown(product.readme)}</div>
          {:else}
            <p class="mt-2 text-[12px] text-muted-foreground">This repo has no README.</p>
          {/if}
        </main>

        <!-- ── Aside: install plan + size ── -->
        <aside class="flex flex-col gap-4">
          <div class="rounded-xl border border-border bg-card p-3">
            <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <HardDrive class="size-3.5" /> Download
            </div>
            <div class="mt-2 text-[13px]" data-testid="product-size">{formatBytes(product.download_size)}</div>
            {#if product.assets.length > 0}
              <ul class="mt-2 flex flex-col gap-1 border-t border-border pt-2">
                {#each product.assets as a (a.name)}
                  <li class="flex items-center justify-between gap-2 text-[11px]">
                    <span class="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <Package class="size-3 shrink-0" />
                      <span class="truncate font-mono" title={a.name}>{a.name}</span>
                    </span>
                    <span class="shrink-0 font-mono text-muted-foreground">{formatBytes(a.size)}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="mt-1 text-[11px] text-muted-foreground">No release assets.</p>
            {/if}
          </div>

          <div class="rounded-xl border border-border bg-card p-3">
            <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <FolderInput class="size-3.5" /> Install plan
            </div>
            {#if product.installable && product.installs.length > 0}
              <ul class="mt-2 flex flex-col gap-2" data-testid="product-installs">
                {#each product.installs as rule (rule.source + rule.dest)}
                  <li class="flex flex-col gap-0.5 text-[11px]">
                    <span class="truncate font-mono text-foreground" title={rule.source}>{rule.source}</span>
                    <span class="flex items-center gap-1 truncate font-mono text-muted-foreground" title={rule.dest}>
                      <ArrowRight class="size-3 shrink-0" />{rule.dest}
                    </span>
                  </li>
                {/each}
              </ul>
            {:else if product.installable}
              <p class="mt-1 text-[11px] text-muted-foreground">Installable, but declares no install rules.</p>
            {:else}
              <p class="mt-1 text-[11px] text-amber-600 dark:text-amber-500" data-testid="product-not-installable">
                Not installable — this release ships no <span class="font-mono">dcs-studio.toml</span>.
              </p>
            {/if}
          </div>

          <a
            href={product.repo_url}
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-[12px] hover:bg-accent"
          >
            View on GitHub <ExternalLink class="size-3.5" />
          </a>
        </aside>
      </div>
    </ScrollArea>
  {/if}
</div>

<style>
  /* Minimal README typography (no Tailwind typography plugin in the project). */
  .readme :global(h1),
  .readme :global(h2),
  .readme :global(h3) {
    font-weight: 600;
    margin: 1.2em 0 0.5em;
    line-height: 1.25;
  }
  .readme :global(h1) { font-size: 1.4em; }
  .readme :global(h2) { font-size: 1.2em; }
  .readme :global(h3) { font-size: 1.05em; }
  .readme :global(p) { margin: 0.6em 0; }
  .readme :global(ul),
  .readme :global(ol) { margin: 0.6em 0; padding-left: 1.4em; }
  .readme :global(ul) { list-style: disc; }
  .readme :global(ol) { list-style: decimal; }
  .readme :global(li) { margin: 0.2em 0; }
  .readme :global(a) { color: var(--foreground); text-decoration: underline; text-underline-offset: 2px; }
  .readme :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--muted);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  .readme :global(pre) {
    background: var(--muted);
    padding: 0.8em;
    border-radius: 8px;
    overflow-x: auto;
    margin: 0.8em 0;
  }
  .readme :global(pre code) { background: transparent; padding: 0; }
  .readme :global(img) { max-width: 100%; height: auto; }
  .readme :global(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 0.9em;
    color: var(--muted-foreground);
    margin: 0.8em 0;
  }
  .readme :global(table) { border-collapse: collapse; margin: 0.8em 0; }
  .readme :global(th),
  .readme :global(td) { border: 1px solid var(--border); padding: 0.3em 0.6em; }
  .readme :global(hr) { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
</style>
