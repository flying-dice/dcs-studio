<script lang="ts">
	import './layout.css';
	import { app } from "$lib/state.svelte";
	import { editorThemeById, chromeVars } from "$lib/themes";

	let { children } = $props();

	// The selected editor theme drives the whole UI. We (a) toggle `.dark` so
	// shadcn's dark-variant utilities + native controls flip, and (b) overwrite
	// the shadcn design tokens with a palette tinted from the editor theme, so
	// the chrome matches the editor's background, accent and text colours.
	$effect(() => {
		const theme = editorThemeById(app.editorThemeId);
		const root = document.documentElement;
		root.classList.toggle("dark", theme.dark);
		root.style.colorScheme = theme.dark ? "dark" : "light";
		for (const [key, value] of Object.entries(chromeVars(theme))) {
			root.style.setProperty(key, value);
		}
	});
</script>

{@render children()}
