// Editor colour themes. The app chrome stays on shadcn's plain light/dark
// tokens (toggled by the `.dark` class on <html>); this registry is the set of
// CodeMirror colour themes the user can pick from. Each theme declares whether
// it is `dark`, so selecting one also flips the chrome to its complementary
// brightness — keeping the editor and the surrounding UI in visual agreement.
import type { Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  dracula,
  cobalt,
  bespin,
  birdsOfParadise,
  coolGlow,
  tomorrow,
  solarizedLight,
  clouds,
  ayuLight,
  noctisLilac,
} from "thememirror";
import {
  dcsDark,
  dcsLight,
  githubDark,
  githubLight,
  jetbrainsDark,
  jetbrainsLight,
} from "./custom-themes";

export interface EditorTheme {
  id: string;
  label: string;
  dark: boolean;
  ext: Extension;
  /** Base palette (sampled from the CodeMirror theme) used to tint the chrome. */
  bg: string;
  fg: string;
  accent: string;
  /** Selection highlight colour — sourced from the theme's own `selection` setting. */
  selection: string;
}

export const EDITOR_THEMES: EditorTheme[] = [
  // ── Dark ──
  { id: "dcs-dark",           label: "DCS Dark",           dark: true,  ext: dcsDark,         bg: "#15181c", fg: "#c9d0d9", accent: "#ffb454", selection: "#2b3a4d" },
  { id: "one-dark",           label: "One Dark",           dark: true,  ext: oneDark,          bg: "#282c34", fg: "#abb2bf", accent: "#61afef", selection: "#3e4451" },
  { id: "dracula",            label: "Dracula",            dark: true,  ext: dracula,          bg: "#2d2f3f", fg: "#f8f8f2", accent: "#bd93f9", selection: "#44475a" },
  { id: "cobalt",             label: "Cobalt",             dark: true,  ext: cobalt,           bg: "#00254b", fg: "#ffffff", accent: "#ff9d00", selection: "#B36539BF" },
  { id: "bespin",             label: "Bespin",             dark: true,  ext: bespin,           bg: "#2e241d", fg: "#baae9e", accent: "#5ea6ea", selection: "#DDF0FF33" },
  { id: "birds-of-paradise",  label: "Birds of Paradise",  dark: true,  ext: birdsOfParadise,  bg: "#3b2627", fg: "#e6e1c4", accent: "#ef5d32", selection: "#16120E" },
  { id: "cool-glow",          label: "Cool Glow",          dark: true,  ext: coolGlow,         bg: "#060521", fg: "#e0e0e0", accent: "#2bf1dc", selection: "#122BBB" },
  { id: "github-dark",        label: "GitHub Dark",        dark: true,  ext: githubDark,       bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff", selection: "#388bfd66" },
  { id: "jetbrains-dark",     label: "JetBrains Dark",     dark: true,  ext: jetbrainsDark,    bg: "#2b2b2b", fg: "#a9b7c6", accent: "#589df6", selection: "#214283" },
  // ── Light ──
  { id: "dcs-light",          label: "DCS Light",          dark: false, ext: dcsLight,         bg: "#fbfaf8", fg: "#33373d", accent: "#b3661a", selection: "#ffe3b3" },
  { id: "tomorrow",           label: "Tomorrow",           dark: false, ext: tomorrow,         bg: "#ffffff", fg: "#4d4d4c", accent: "#8959a8", selection: "#D6D6D6" },
  { id: "solarized-light",    label: "Solarized Light",    dark: false, ext: solarizedLight,   bg: "#fef7e5", fg: "#586e75", accent: "#268bd2", selection: "#073642" },
  { id: "clouds",             label: "Clouds",             dark: false, ext: clouds,           bg: "#ffffff", fg: "#1f1f1f", accent: "#9a6e3a", selection: "#BDD5FC" },
  { id: "ayu-light",          label: "Ayu Light",          dark: false, ext: ayuLight,         bg: "#fcfcfc", fg: "#5c6166", accent: "#fa8d3e", selection: "#036dd626" },
  { id: "noctis-lilac",       label: "Noctis Lilac",       dark: false, ext: noctisLilac,      bg: "#f2f1f8", fg: "#0c006b", accent: "#ff5792", selection: "#d5d1f2" },
  { id: "github-light",       label: "GitHub Light",       dark: false, ext: githubLight,      bg: "#ffffff", fg: "#24292e", accent: "#0969da", selection: "#0366d625" },
  { id: "jetbrains-light",    label: "JetBrains Light",    dark: false, ext: jetbrainsLight,   bg: "#ffffff", fg: "#080808", accent: "#3574f0", selection: "#a6d2ff" },
];

export const DEFAULT_DARK_THEME = "dcs-dark";
export const DEFAULT_LIGHT_THEME = "dcs-light";

export function editorThemeById(id: string): EditorTheme {
  return EDITOR_THEMES.find((t) => t.id === id) ?? EDITOR_THEMES[0];
}

/**
 * Bridge an editor theme onto the shadcn design tokens so the whole UI is
 * tinted to match the editor. Derived shades are computed with color-mix so a
 * single base palette (bg / fg / accent) drives every surface, border and
 * muted tone. Returns a map of CSS custom property → value to set on <html>.
 */
export function chromeVars(theme: EditorTheme): Record<string, string> {
  const { bg, fg, accent, selection } = theme;
  const mix = (a: string, b: string, p: number) =>
    `color-mix(in oklab, ${a}, ${b} ${p}%)`;

  const canvas = mix(bg, fg, 7); // surface behind the islands
  const elevated = mix(bg, fg, 12); // secondary / muted / hover surfaces
  const border = mix(bg, fg, 16);
  const dim = mix(fg, bg, 42); // muted foreground

  return {
    "--cm-selection": selection,
    // A translucent active-line wash: mixes the theme's own foreground, so it's
    // a light wash on dark themes and a dark wash on light. Kept translucent so
    // the selection layer (drawn behind .cm-content) and the debug current-line
    // highlight read through it — see the .cm-activeLine override in layout.css.
    "--cm-line-highlight": mix(fg, "transparent", 93),
    "--background": canvas,
    "--foreground": fg,
    "--card": bg,
    "--card-foreground": fg,
    "--popover": bg,
    "--popover-foreground": fg,
    "--primary": accent,
    "--primary-foreground": bg,
    "--secondary": elevated,
    "--secondary-foreground": fg,
    "--muted": elevated,
    "--muted-foreground": dim,
    "--accent": elevated,
    "--accent-foreground": fg,
    "--border": border,
    "--input": border,
    "--ring": accent,
    "--sidebar": bg,
    "--sidebar-foreground": fg,
    "--sidebar-primary": accent,
    "--sidebar-primary-foreground": bg,
    "--sidebar-accent": elevated,
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": border,
    "--sidebar-ring": accent,
  };
}
