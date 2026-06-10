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

export interface EditorTheme {
  id: string;
  label: string;
  dark: boolean;
  ext: Extension;
  /** Base palette (sampled from the CodeMirror theme) used to tint the chrome. */
  bg: string;
  fg: string;
  accent: string;
}

export const EDITOR_THEMES: EditorTheme[] = [
  // ── Dark ──
  { id: "one-dark", label: "One Dark", dark: true, ext: oneDark, bg: "#282c34", fg: "#abb2bf", accent: "#61afef" },
  { id: "dracula", label: "Dracula", dark: true, ext: dracula, bg: "#2d2f3f", fg: "#f8f8f2", accent: "#bd93f9" },
  { id: "cobalt", label: "Cobalt", dark: true, ext: cobalt, bg: "#00254b", fg: "#ffffff", accent: "#ff9d00" },
  { id: "bespin", label: "Bespin", dark: true, ext: bespin, bg: "#2e241d", fg: "#baae9e", accent: "#5ea6ea" },
  { id: "birds-of-paradise", label: "Birds of Paradise", dark: true, ext: birdsOfParadise, bg: "#3b2627", fg: "#e6e1c4", accent: "#ef5d32" },
  { id: "cool-glow", label: "Cool Glow", dark: true, ext: coolGlow, bg: "#060521", fg: "#e0e0e0", accent: "#2bf1dc" },
  // ── Light ──
  { id: "tomorrow", label: "Tomorrow", dark: false, ext: tomorrow, bg: "#ffffff", fg: "#4d4d4c", accent: "#8959a8" },
  { id: "solarized-light", label: "Solarized Light", dark: false, ext: solarizedLight, bg: "#fef7e5", fg: "#586e75", accent: "#268bd2" },
  { id: "clouds", label: "Clouds", dark: false, ext: clouds, bg: "#ffffff", fg: "#1f1f1f", accent: "#9a6e3a" },
  { id: "ayu-light", label: "Ayu Light", dark: false, ext: ayuLight, bg: "#fcfcfc", fg: "#5c6166", accent: "#fa8d3e" },
  { id: "noctis-lilac", label: "Noctis Lilac", dark: false, ext: noctisLilac, bg: "#f2f1f8", fg: "#0c006b", accent: "#ff5792" },
];

export const DEFAULT_DARK_THEME = "one-dark";
export const DEFAULT_LIGHT_THEME = "tomorrow";

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
  const { bg, fg, accent } = theme;
  const mix = (a: string, b: string, p: number) =>
    `color-mix(in oklab, ${a}, ${b} ${p}%)`;

  const canvas = mix(bg, fg, 7); // surface behind the islands
  const elevated = mix(bg, fg, 12); // secondary / muted / hover surfaces
  const border = mix(bg, fg, 16);
  const dim = mix(fg, bg, 42); // muted foreground

  return {
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
