<script lang="ts">
  // Recipes panel (issue #49 Part B): a searchable, category-filtered catalog of
  // small DCS Lua snippets (src/lib/recipes.ts). Each card runs in the Lua
  // console (against the live sim) or copies to the clipboard. Pure content/UI —
  // no model body; the catalog + filter are runes-free in $lib/recipes.
  import { Search, Play, Copy, Check, FilePlus, BookOpen, Plane } from "@lucide/svelte";
  import { recipes as appRecipes, type RecipesLibrary } from "$lib/recipes.svelte";
  import { RECIPE_CATEGORIES, categoryLabel, type Recipe } from "$lib/recipes";
  import { luaConsole } from "$lib/lua-console.svelte";
  import { cn } from "$lib/utils.js";
  import { onDestroy } from "svelte";

  // Injectable store (same seam as Database/Todos) so a lab page / e2e can drive
  // the real store without the app singleton.
  let { store = appRecipes }: { store?: RecipesLibrary } = $props();

  // Category chips: "All" plus every catalog category, in display order.
  const chips = [{ id: "all" as const, label: "All" }, ...RECIPE_CATEGORIES];

  // Transient per-card "Copied" acknowledgement.
  let copiedId = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(recipe: Recipe) {
    await store.copy(recipe);
    copiedId = recipe.id;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedId = null), 1200);
  }

  onDestroy(() => clearTimeout(copiedTimer));
</script>

<div class="flex h-full flex-col text-[12px]" data-testid="recipes-panel">
  <!-- SEARCH -->
  <div class="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
    <Search class="size-3.5 shrink-0 text-muted-foreground" />
    <input
      type="text"
      class="w-full bg-transparent text-[12px] placeholder:text-muted-foreground focus:outline-none"
      placeholder="Search recipes…"
      aria-label="Search recipes"
      data-testid="recipes-search"
      bind:value={store.query}
    />
  </div>

  <!-- CATEGORY CHIPS -->
  <div class="flex shrink-0 flex-wrap gap-1 border-b border-border/60 px-2 py-1.5">
    {#each chips as chip (chip.id)}
      <button
        type="button"
        class={cn(
          "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
          store.category === chip.id
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        data-testid="recipes-category"
        aria-pressed={store.category === chip.id}
        onclick={() => (store.category = chip.id)}
      >
        {chip.label}
      </button>
    {/each}
  </div>

  <!-- CARDS -->
  <div class="min-h-0 flex-1 overflow-auto">
    {#if store.filtered.length === 0}
      <div
        class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
        data-testid="recipes-empty"
      >
        <BookOpen class="size-7 opacity-60" />
        <p>No recipes match your search.</p>
      </div>
    {:else}
      <div class="flex flex-col gap-1.5 p-2">
        {#each store.filtered as recipe (recipe.id)}
          <div
            class="rounded-lg border border-border/70 bg-card/40 px-2.5 py-2"
            data-testid="recipes-card"
          >
            <div class="flex items-center gap-1.5">
              <span class="truncate font-medium text-foreground">{recipe.title}</span>
              {#if recipe.needsMission}
                <span
                  class="flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                  title="Only returns live data while a mission is running (model time > 0)"
                >
                  <Plane class="size-2.5" />
                  in-mission
                </span>
              {/if}
              <span class="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {categoryLabel(recipe.category)}
              </span>
            </div>

            <p class="mt-0.5 text-[11px] text-muted-foreground">{recipe.blurb}</p>

            <pre
              class="mt-1.5 max-h-32 overflow-auto rounded bg-muted/60 px-2 py-1 font-mono text-[10.5px] leading-relaxed"><code
                >{recipe.code}</code
              ></pre>

            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                class="flex items-center gap-1 rounded bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                data-testid="recipes-run"
                title="Run in the Lua console against the live sim"
                disabled={luaConsole.running}
                onclick={() => store.runInConsole(recipe)}
              >
                <Play class={cn("size-3.5", luaConsole.running && "animate-pulse")} />
                Run
              </button>
              <button
                type="button"
                class="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                data-testid="recipes-copy"
                title="Copy the snippet to the clipboard"
                onclick={() => void copy(recipe)}
              >
                {#if copiedId === recipe.id}
                  <Check class="size-3.5 text-emerald-500" />
                  Copied
                {:else}
                  <Copy class="size-3.5" />
                  Copy
                {/if}
              </button>
              <button
                type="button"
                class="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                data-testid="recipes-new-file"
                title="Create a new file from this snippet at the workspace root"
                onclick={() => store.openFromRecipe(recipe)}
              >
                <FilePlus class="size-3.5" />
                New file
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
