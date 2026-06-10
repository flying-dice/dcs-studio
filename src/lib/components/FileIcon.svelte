<script lang="ts">
  // Inlines a vendored IntelliJ Platform SVG icon (see $lib/icons/jetbrains).
  // Icons are pre-coloured and ship light/dark variants, so the component picks
  // the `_dark` file whenever the chrome is dark, falling back to the light one.
  import { app } from "$lib/state.svelte";
  import { cn } from "$lib/utils.js";

  const svgs = import.meta.glob("../icons/jetbrains/*.svg", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  let { name, class: cls }: { name: string; class?: string } = $props();

  const html = $derived(
    (app.dark ? svgs[`../icons/jetbrains/${name}_dark.svg`] : undefined) ??
      svgs[`../icons/jetbrains/${name}.svg`] ??
      svgs["../icons/jetbrains/anyType.svg"],
  );
</script>

<span class={cn("inline-flex shrink-0 [&>svg]:size-full", cls ?? "size-4")} aria-hidden="true">
  {@html html}
</span>
