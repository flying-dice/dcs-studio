<script lang="ts">
  // Structure panel: the active file's symbol outline from the language
  // engine (model/studio/lang.pds — RefreshOutline / OpenSymbol /
  // EnclosingSymbol). Clicking a row navigates the editor to the symbol's
  // name; the highlighted row follows the editor caret.
  import { lang } from "$lib/lang/intel.svelte";
  import { revealInEditor } from "$lib/lang/codemirror";
  import StructureNode from "./StructureNode.svelte";
  import type { DocumentSymbol } from "$lib/lang/provider";

  /** The file to outline — the workbench passes the active editor file. */
  let { path = null }: { path?: string | null } = $props();

  // Re-outline whenever the active file changes; edits re-enter through
  // the lint debounce (lang.updateSource → refreshOutline).
  $effect(() => {
    void lang.refreshOutline(path);
  });

  /** The innermost symbol whose span contains `offset` (model
   * `EnclosingSymbol`); spans and the caret are both UTF-16 here. */
  function enclosingSymbol(
    symbols: DocumentSymbol[],
    offset: number,
  ): DocumentSymbol | null {
    for (const symbol of symbols) {
      if (offset < symbol.start || offset > symbol.end) continue;
      return enclosingSymbol(symbol.children, offset) ?? symbol;
    }
    return null;
  }

  // Selection follows the (debounced) editor caret.
  const current = $derived.by(() => {
    const cursor = lang.cursor;
    if (!cursor || cursor.path !== path) return null;
    return enclosingSymbol(lang.symbols, cursor.offset);
  });

  function open(symbol: DocumentSymbol) {
    if (path) revealInEditor(path, symbol.selection_start);
  }
</script>

<div class="h-full py-1" data-testid="structure-panel">
  {#if lang.symbols.length === 0}
    <div
      class="flex h-full min-h-[120px] items-center justify-center px-4 text-center text-[12px] text-muted-foreground"
    >
      No structure for this file type
    </div>
  {:else}
    {#each lang.symbols as symbol, index (index)}
      <StructureNode {symbol} depth={0} {current} onopen={open} />
    {/each}
  {/if}
</div>
