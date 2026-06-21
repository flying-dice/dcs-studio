// Recipes panel store (issue #49 Part B): the search box + category filter over
// the static catalog, plus the three card actions. A separate singleton from
// `app` (same convention as `database`/`todos`); the panel reads here.
//
// The catalog and the filter live in the runes-free ./recipes module (vitest
// covers them); this store only holds the live query/category and the thin
// action wiring. The actions delegate to known-good seams — the Lua console
// (`luaConsole.run`, the same path as the editor's "Run in DCS") and the
// clipboard — so they carry no logic of their own to test (cf. runViewInDcs,
// tree-actions copy; both untested by the same convention).

import { app } from "./state.svelte";
import { luaConsole } from "./lua-console.svelte";
import {
  RECIPES,
  filterRecipes,
  type Recipe,
  type RecipeCategory,
} from "./recipes";

export class RecipesLibrary {
  constructor(private readonly catalog: Recipe[] = RECIPES) {}

  /** The live search box contents. */
  query = $state("");
  /** The selected category chip, or "all". */
  category = $state<RecipeCategory | "all">("all");

  /** The catalog narrowed by the current category + query (model-free: pure
   *  ./recipes logic). */
  get filtered(): Recipe[] {
    return filterRecipes(this.catalog, this.query, this.category);
  }

  /** Jump to a category, clearing any stale query. The Database panel's empty
   *  state deep-links here (its "Browse SQLite recipes" button → "sqlite"). */
  focusCategory(category: RecipeCategory | "all"): void {
    this.category = category;
    this.query = "";
  }

  /** Run a recipe in the Lua console against the live sim, revealing the
   *  console (model studio::core Workbench.RunLua — the runViewInDcs path). */
  runInConsole(recipe: Recipe): void {
    app.bottomTool = "lua";
    void luaConsole.run(recipe.code);
  }

  /** Copy a recipe's code to the clipboard. */
  async copy(recipe: Recipe): Promise<void> {
    await navigator.clipboard?.writeText(recipe.code);
  }
}

/** The app-wide instance (a lab/e2e harness builds its own with a fake catalog). */
export const recipes = new RecipesLibrary();
