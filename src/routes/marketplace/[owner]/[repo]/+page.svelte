<script lang="ts">
  // A mod's product page (model studio::market `LoadProduct`, issue #10): the
  // README, the install plan parsed from `dcs-studio.toml` (what installs where),
  // and the download size. Reached from a store card; sign-in gated like the
  // store. Install/download itself is a later slice.
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { marketplace } from "$lib/marketplace.svelte";
  import { cargolua } from "$lib/cargolua.svelte";
  import { app } from "$lib/state.svelte";
  import { renderMarkdown } from "$lib/lang/markdown";
  import { readTextFile, writeTextFile, type InstallProgress } from "$lib/api";
  import { errorMessage } from "$lib/utils";
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
    RefreshCw,
    Download,
    Check,
    Trash2,
    Library,
    Plus,
    Boxes,
    TriangleAlert,
    X,
  } from "@lucide/svelte";

  const owner = $derived($page.params.owner ?? "");
  const repo = $derived($page.params.repo ?? "");
  const product = $derived(marketplace.product);

  // The per-node phase shown while an install runs (issue #62).
  const INSTALL_PHASE_LABEL: Record<InstallProgress["phase"], string> = {
    download: "Downloading",
    link: "Linking",
  };

  /** Plan-node completion 0–100 (the current node of the total). */
  function nodePercent(p: InstallProgress): number {
    if (p.nodes === 0) return 0;
    return Math.min(100, Math.round((p.node / p.nodes) * 100));
  }

  // Load (or reload) when the route params change and the user is signed in,
  // and refresh which mods are installed (drives the Install/Installed button).
  $effect(() => {
    if (app.session && owner && repo) {
      void marketplace.loadProduct(owner, repo);
      void marketplace.refreshInstalled();
    }
  });

  const installed = $derived(product ? marketplace.isInstalled(product.repo) : false);

  // ── "Add as dependency" (#48): write the library into CargoLua.toml ──
  let depBusy = $state(false);
  let depNotice = $state<{ ok: boolean; text: string } | null>(null);

  /** Derive a Lua-ident-ish dependency key from the repo name: lowercase, with
   * non-alphanumerics collapsed to `_`, and a leading digit prefixed so it's a
   * valid identifier. */
  function depKey(name: string): string {
    const k = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!k) return "dep";
    return /^[0-9]/.test(k) ? `_${k}` : k;
  }

  /** Escape a value for a TOML basic string: drop control chars, then escape
   * backslash and double-quote (so a `"` in a tag can't break out). */
  function tomlStr(s: string): string {
    let out = "";
    for (const ch of s) {
      const c = ch.codePointAt(0) ?? 0;
      if (c < 0x20) continue; // drop control chars
      if (ch === "\\") out += "\\\\";
      else if (ch === '"') out += '\\"';
      else out += ch;
    }
    return out;
  }

  /** Insert/replace the `<key> = {...}` line under `[dependencies]`, adding the
   * section (and a `[package]`/`[dependencies]` skeleton for a fresh file). */
  function upsertDependency(toml: string, key: string, line: string): string {
    const entry = `${key} = ${line}`;
    const lines = toml.split(/\r?\n/);
    // Find the [dependencies] section header.
    const depIdx = lines.findIndex((l) => /^\s*\[dependencies\]\s*(#.*)?$/.test(l));
    if (depIdx === -1) {
      const body = toml.replace(/\s*$/, "");
      const prefix = body ? `${body}\n\n` : "";
      return `${prefix}[dependencies]\n${entry}\n`;
    }
    // Within the section (until the next `[`), find an existing `<key> =`.
    const keyRe = new RegExp(`^\\s*${key}\\s*=`);
    for (let i = depIdx + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break; // next section
      if (keyRe.test(lines[i])) {
        lines[i] = entry;
        return lines.join("\n");
      }
    }
    lines.splice(depIdx + 1, 0, entry);
    return lines.join("\n");
  }

  async function addAsDependency(): Promise<void> {
    if (depBusy || !product || !app.rootPath) return;
    depBusy = true;
    depNotice = null;
    try {
      const sep = app.rootPath.includes("\\") ? "\\" : "/";
      const path = `${app.rootPath.replace(/[\\/]+$/, "")}${sep}CargoLua.toml`;
      // owner/name comes from product.repo ("owner/name").
      const slug = product.repo;
      const name = product.name;
      const key = depKey(name);
      const tag = product.release_tag ?? "";
      // Escape interpolated values for a TOML basic string — a git tag may
      // legally contain `"`, which would otherwise inject into CargoLua.toml.
      // OMIT `tag` when the library has no release: an empty tag would lock to
      // `tag = ""` → `git checkout ""` → RefNotFound. None → the default branch,
      // which is the right source for a topic-only library with no tagged release.
      const line = tag
        ? `{ github = "${tomlStr(slug)}", tag = "${tomlStr(tag)}" }`
        : `{ github = "${tomlStr(slug)}" }`;

      let toml = "";
      try {
        toml = await readTextFile(path);
      } catch {
        // Absent file → minimal skeleton.
        toml = `[package]\nname = "${tomlStr(name)}"\n\n[dependencies]\n`;
      }
      const next = upsertDependency(toml, key, line);
      await writeTextFile(path, next);
      // Close the loop in one gesture: fetch immediately so the library is
      // vendored and the editor re-indexes it — no drop to a terminal (model
      // `studio::cargolua::AddDependencyTriggersFetch`). The Dependencies panel
      // shows the fetch progress + outcome.
      if (app.rootPath) void cargolua.fetch(app.rootPath);
      depNotice = { ok: true, text: `Added ${key} to CargoLua.toml — fetching…` };
    } catch (error) {
      depNotice = { ok: false, text: errorMessage(error) };
    } finally {
      depBusy = false;
    }
  }

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
    <div class="ml-auto flex items-center gap-2">
      {#if app.session}
        <Button
          variant="ghost"
          size="sm"
          class="gap-1.5"
          title="Re-fetch this mod from GitHub"
          disabled={marketplace.productBusy}
          onclick={() => marketplace.loadProduct(owner, repo)}
          data-testid="product-refresh"
        >
          <RefreshCw class={marketplace.productBusy ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
        <GithubAuth />
      {/if}
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

        <!-- ── Aside: install action + plan + size ── -->
        <aside class="flex flex-col gap-4">
          <!-- Install / Installed / Add as dependency (library) -->
          <div class="rounded-xl border border-border bg-card p-3">
            {#if product.is_library}
              <div class="flex items-center gap-1.5 text-[12px] font-medium" data-testid="product-library">
                <Library class="size-4 text-muted-foreground" /> Library
              </div>
              <Button
                size="sm"
                class="mt-2 w-full gap-1.5"
                disabled={depBusy || !app.rootPath || cargolua.running}
                onclick={addAsDependency}
                data-testid="product-add-dependency"
              >
                {#if depBusy || cargolua.running}
                  <LoaderCircle class="size-3.5 animate-spin" /> {depBusy ? "Adding…" : "Fetching…"}
                {:else}
                  <Plus class="size-3.5" /> Add as dependency
                {/if}
              </Button>
              {#if app.rootPath}
                <p class="mt-1.5 text-[11px] text-muted-foreground">
                  Adds <span class="font-mono">{depKey(product.name)}</span> to your project's
                  <span class="font-mono">CargoLua.toml</span> — a dependency-only library, not installed into DCS.
                </p>
              {:else}
                <p class="mt-1.5 text-[11px] text-amber-600 dark:text-amber-500" data-testid="product-no-project">
                  Open a project first to add this as a dependency.
                </p>
              {/if}
              {#if depNotice}
                <p
                  class={depNotice.ok
                    ? "mt-2 text-[11px] text-emerald-600 dark:text-emerald-500"
                    : "mt-2 text-[11px] text-destructive"}
                  data-testid="product-dependency-notice"
                >
                  {depNotice.text}
                </p>
              {/if}
            {:else if !product.installable}
              <p class="text-[12px] text-amber-600 dark:text-amber-500" data-testid="product-cannot-install">
                Not installable — this release ships no <span class="font-mono">dcs-studio.toml</span>.
              </p>
            {:else if installed}
              <div class="flex items-center gap-1.5 text-[12px] text-emerald-600 dark:text-emerald-500">
                <Check class="size-4" /> Installed
              </div>
              <Button
                variant="outline"
                size="sm"
                class="mt-2 w-full gap-1.5"
                disabled={marketplace.installBusy}
                onclick={() => marketplace.uninstall(product.repo)}
                data-testid="product-uninstall"
              >
                {#if marketplace.installBusy}
                  <LoaderCircle class="size-3.5 animate-spin" />
                {:else}
                  <Trash2 class="size-3.5" />
                {/if}
                Uninstall
              </Button>
            {:else}
              <Button
                size="sm"
                class="w-full gap-1.5"
                disabled={marketplace.installBusy}
                onclick={() => marketplace.install(owner, repo)}
                data-testid="product-install"
              >
                {#if marketplace.installBusy}
                  <LoaderCircle class="size-3.5 animate-spin" /> Installing…
                {:else}
                  <Download class="size-3.5" /> Install
                {/if}
              </Button>
              {#if marketplace.installingId === product.repo}
                {@const p = marketplace.installProgress}
                <div class="mt-2 rounded-lg border border-border bg-card p-2.5" data-testid="product-install-progress">
                  <div class="flex items-center justify-between gap-2">
                    <span class="flex items-center gap-1.5 text-[12px]">
                      <LoaderCircle class="size-3 animate-spin" />
                      {#if p}
                        {INSTALL_PHASE_LABEL[p.phase]} <span class="font-mono">{p.id}</span>
                      {:else}
                        Resolving…
                      {/if}
                    </span>
                    <button
                      class="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      onclick={() => marketplace.cancelInstall()}
                      data-testid="product-install-cancel"
                    >
                      <X class="size-3" /> Cancel
                    </button>
                  </div>
                  <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    {#if p}
                      <div class="h-full rounded-full bg-primary transition-[width]" style="width: {nodePercent(p)}%"></div>
                    {:else}
                      <div class="h-full w-1/3 animate-pulse rounded-full bg-primary/60"></div>
                    {/if}
                  </div>
                  <p class="mt-1 text-[10px] text-muted-foreground">
                    {#if p}Installing {p.node} of {p.nodes}{:else}Resolving dependencies…{/if}
                  </p>
                </div>
              {/if}
              <p class="mt-1.5 text-[11px] text-muted-foreground">
                Links the files into your DCS folders (no copy); uninstall removes the links.
              </p>
            {/if}
            {#if marketplace.installError}
              <p class="mt-2 text-[11px] text-destructive" data-testid="product-install-error">{marketplace.installError}</p>
            {/if}
            {#if marketplace.installNotice}
              <p class="mt-2 text-[11px] text-muted-foreground" data-testid="product-install-notice">{marketplace.installNotice}</p>
            {/if}
            {#if marketplace.installWarnings.length > 0}
              <ul class="mt-2 flex flex-col gap-1" data-testid="product-install-warnings">
                {#each marketplace.installWarnings as w (w)}
                  <li class="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                    <TriangleAlert class="mt-0.5 size-3 shrink-0" /><span>{w}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          {#if product.installable && product.dependencies.length > 0}
            <div class="rounded-xl border border-border bg-card p-3">
              <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <Boxes class="size-3.5" /> Dependencies
              </div>
              <p class="mt-1.5 text-[11px] text-muted-foreground">
                Installing this also installs {product.dependencies.length === 1 ? "this mod" : "these mods"}:
              </p>
              <ul class="mt-2 flex flex-col gap-2" data-testid="product-dependencies">
                {#each product.dependencies as d (d.id)}
                  <li class="flex flex-col gap-0.5 text-[11px]">
                    <a
                      href={`/marketplace/${d.id}`}
                      class="truncate font-mono text-foreground underline-offset-2 hover:underline"
                      title={d.id}
                    >
                      {d.id}
                    </a>
                    <span class="flex items-center gap-1.5 font-mono text-muted-foreground">
                      <span>{d.version && d.version !== "*" ? d.version : "any version"}</span>
                      {#if d.optional}<span class="rounded bg-muted px-1 py-0.5 text-[10px]">optional</span>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

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

          {#if product.installable}
            <div class="rounded-xl border border-border bg-card p-3">
              <div class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <FolderInput class="size-3.5" /> Install plan
              </div>
              {#if product.installs.length > 0}
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
              {:else}
                <p class="mt-1 text-[11px] text-muted-foreground">Installable, but declares no install rules.</p>
              {/if}
            </div>
          {/if}

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
