<script lang="ts">
	import './layout.css';
	import { onMount } from "svelte";
	import { app } from "$lib/state.svelte";
	import { mcp } from "$lib/mcp.svelte";
	import { notifications } from "$lib/notifications.svelte";
	import { deeplinks } from "$lib/deeplink";
	import { editorThemeById, chromeVars } from "$lib/themes";

	let { children } = $props();

	// Start listening for the Rust-side DCS link events (status bar feed),
	// snapshot the IDE-hosted MCP server status (issue #39) for the status bar,
	// and arm the notification center's event listeners (issue #56) so events
	// are captured even before the panel is ever opened.
	onMount(() => {
		app.initDcs();
		void app.initWatcher();
		void mcp.refresh();
		void notifications.init();
		// Route incoming dcs-studio:// links (marketplace / open) into the IDE,
		// and drain any link that cold-started it (issue #44).
		void deeplinks.init();
	});

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
