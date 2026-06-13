<script lang="ts">
	import './layout.css';
	import { onMount } from "svelte";
	import { app } from "$lib/state.svelte";
	import { lang } from "$lib/lang/intel.svelte";
	import { editorThemeById, chromeVars } from "$lib/themes";

	let { children } = $props();

	// Start listening for the Rust-side DCS link events (status bar feed).
	onMount(() => {
		app.initDcs();
	});

	// Dev-only HMR recovery (issue #31): a hot-update to the language modules
	// recreates `lang` (engine "off") while `app` — and its open project —
	// survive via import.meta.hot.data (state.svelte.ts). Re-mount so the
	// engine re-attaches to the backend server that outlived the reload. In
	// production builds import.meta.hot is undefined: the effect returns before
	// reading any state, subscribes to nothing, and never re-runs.
	$effect(() => {
		if (!import.meta.hot) return;
		if (lang.engineStatus === "off" && app.rootPath) {
			void lang.mountWorkspace(app.rootPath);
		}
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
