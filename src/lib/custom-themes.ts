// Hand-authored CodeMirror themes that aren't shipped by thememirror.
// The DCS pair is the app's house style, drawn from Digital Combat Simulator's
// cockpit aesthetic: charcoal panels, amber instrument lighting, HUD green and
// avionics cyan. The GitHub and JetBrains palettes are sampled from the
// official sources: GitHub's Primer "prettylights" syntax scales and
// JetBrains' Darcula / IntelliJ Light editor schemes.
import { tags as t } from "@lezer/highlight";
import { createTheme } from "thememirror";

// DCS Dark — night-lit cockpit: charcoal panel, amber primaries, HUD green
// strings and avionics cyan numerals.
export const dcsDark = createTheme({
  variant: "dark",
  settings: {
    background: "#15181c",
    foreground: "#c9d0d9",
    caret: "#ffb454",
    selection: "#2b3a4d",
    lineHighlight: "#1d2126",
    gutterBackground: "#15181c",
    gutterForeground: "#4d5663",
  },
  styles: [
    {
      tag: [t.comment, t.docComment],
      color: "#5f6b7a",
      fontStyle: "italic",
    },
    {
      tag: [t.keyword, t.modifier, t.operatorKeyword],
      color: "#ffb454",
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: "#5ccfe6",
    },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: "#95c76f",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.propertyName)],
      color: "#ffd580",
    },
    {
      tag: [t.className, t.typeName, t.definition(t.typeName)],
      color: "#73b8ff",
    },
    {
      tag: [t.constant(t.variableName), t.standard(t.variableName)],
      color: "#5ccfe6",
    },
    {
      tag: [t.meta, t.annotation],
      color: "#8a9199",
    },
    {
      tag: t.tagName,
      color: "#ffb454",
    },
    {
      tag: t.attributeName,
      color: "#ffd580",
    },
    {
      tag: t.attributeValue,
      color: "#95c76f",
    },
    {
      tag: [t.heading, t.strong],
      color: "#ffb454",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      fontStyle: "italic",
    },
    {
      tag: t.link,
      color: "#5ccfe6",
      textDecoration: "underline",
    },
    {
      tag: t.invalid,
      color: "#f27983",
    },
  ],
});

// DCS Light — daylight cockpit: warm paper panel with the same amber / green /
// cyan signal colours at print contrast.
export const dcsLight = createTheme({
  variant: "light",
  settings: {
    background: "#fbfaf8",
    foreground: "#33373d",
    caret: "#b3661a",
    selection: "#ffe3b3",
    lineHighlight: "#f4f1ea",
    gutterBackground: "#fbfaf8",
    gutterForeground: "#a39e93",
  },
  styles: [
    {
      tag: [t.comment, t.docComment],
      color: "#948f85",
      fontStyle: "italic",
    },
    {
      tag: [t.keyword, t.modifier, t.operatorKeyword],
      color: "#b3590f",
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: "#0f7b8a",
    },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: "#3f7d20",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.propertyName)],
      color: "#9a6700",
    },
    {
      tag: [t.className, t.typeName, t.definition(t.typeName)],
      color: "#265fb5",
    },
    {
      tag: [t.constant(t.variableName), t.standard(t.variableName)],
      color: "#0f7b8a",
    },
    {
      tag: [t.meta, t.annotation],
      color: "#8a7500",
    },
    {
      tag: t.tagName,
      color: "#b3590f",
    },
    {
      tag: t.attributeName,
      color: "#9a6700",
    },
    {
      tag: t.attributeValue,
      color: "#3f7d20",
    },
    {
      tag: [t.heading, t.strong],
      color: "#b3590f",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      fontStyle: "italic",
    },
    {
      tag: t.link,
      color: "#0f7b8a",
      textDecoration: "underline",
    },
    {
      tag: t.invalid,
      color: "#d13438",
    },
  ],
});

export const githubDark = createTheme({
  variant: "dark",
  settings: {
    background: "#0d1117",
    foreground: "#c9d1d9",
    caret: "#c9d1d9",
    selection: "#388bfd66",
    lineHighlight: "#6e76811a",
    gutterBackground: "#0d1117",
    gutterForeground: "#6e7681",
  },
  styles: [
    {
      tag: [t.comment, t.bracket],
      color: "#8b949e",
    },
    {
      tag: [t.className, t.propertyName],
      color: "#d2a8ff",
    },
    {
      tag: [t.variableName, t.attributeName, t.number, t.operator],
      color: "#79c0ff",
    },
    {
      tag: [t.keyword, t.typeName, t.typeOperator],
      color: "#ff7b72",
    },
    {
      tag: [t.string, t.meta, t.regexp],
      color: "#a5d6ff",
    },
    {
      tag: [t.name, t.quote],
      color: "#7ee787",
    },
    {
      tag: [t.heading, t.strong],
      color: "#d2a8ff",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      color: "#d2a8ff",
      fontStyle: "italic",
    },
    {
      tag: t.deleted,
      color: "#ffdcd7",
    },
    {
      tag: [t.atom, t.bool, t.special(t.variableName)],
      color: "#ffab70",
    },
    {
      tag: t.invalid,
      color: "#f97583",
    },
  ],
});

export const githubLight = createTheme({
  variant: "light",
  settings: {
    background: "#ffffff",
    foreground: "#24292e",
    caret: "#24292e",
    selection: "#0366d625",
    lineHighlight: "#f6f8fa",
    gutterBackground: "#ffffff",
    gutterForeground: "#6e7781",
  },
  styles: [
    {
      tag: [t.comment, t.bracket],
      color: "#6a737d",
    },
    {
      tag: [t.className, t.propertyName],
      color: "#6f42c1",
    },
    {
      tag: [t.variableName, t.attributeName, t.number, t.operator],
      color: "#005cc5",
    },
    {
      tag: [t.keyword, t.typeName, t.typeOperator],
      color: "#d73a49",
    },
    {
      tag: [t.string, t.meta, t.regexp],
      color: "#032f62",
    },
    {
      tag: [t.name, t.quote],
      color: "#22863a",
    },
    {
      tag: [t.heading, t.strong],
      color: "#24292e",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      color: "#24292e",
      fontStyle: "italic",
    },
    {
      tag: t.deleted,
      color: "#b31d28",
    },
    {
      tag: [t.atom, t.bool, t.special(t.variableName)],
      color: "#e36209",
    },
    {
      tag: t.invalid,
      color: "#cb2431",
    },
  ],
});

// JetBrains Darcula — the classic IntelliJ dark scheme.
export const jetbrainsDark = createTheme({
  variant: "dark",
  settings: {
    background: "#2b2b2b",
    foreground: "#a9b7c6",
    caret: "#bbbbbb",
    selection: "#214283",
    lineHighlight: "#323232",
    gutterBackground: "#313335",
    gutterForeground: "#606366",
  },
  styles: [
    {
      tag: t.comment,
      color: "#808080",
    },
    {
      tag: t.docComment,
      color: "#629755",
      fontStyle: "italic",
    },
    {
      tag: [t.keyword, t.modifier, t.operatorKeyword],
      color: "#cc7832",
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: "#6897bb",
    },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: "#6a8759",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.propertyName)],
      color: "#ffc66d",
    },
    {
      tag: [t.constant(t.variableName), t.standard(t.variableName), t.propertyName],
      color: "#9876aa",
    },
    {
      tag: [t.meta, t.annotation],
      color: "#bbb529",
    },
    {
      tag: t.tagName,
      color: "#e8bf6a",
    },
    {
      tag: t.attributeName,
      color: "#bababa",
    },
    {
      tag: t.attributeValue,
      color: "#a5c261",
    },
    {
      tag: [t.heading, t.strong],
      color: "#a9b7c6",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      fontStyle: "italic",
    },
    {
      tag: t.link,
      color: "#589df6",
      textDecoration: "underline",
    },
    {
      tag: t.invalid,
      color: "#bc3f3c",
    },
  ],
});

// IntelliJ Light — the default JetBrains light scheme.
export const jetbrainsLight = createTheme({
  variant: "light",
  settings: {
    background: "#ffffff",
    foreground: "#080808",
    caret: "#000000",
    selection: "#a6d2ff",
    lineHighlight: "#fcfaed",
    gutterBackground: "#f2f2f2",
    gutterForeground: "#adadad",
  },
  styles: [
    {
      tag: t.comment,
      color: "#8c8c8c",
      fontStyle: "italic",
    },
    {
      tag: t.docComment,
      color: "#8c8c8c",
      fontStyle: "italic",
    },
    {
      tag: [t.keyword, t.modifier, t.operatorKeyword],
      color: "#0033b3",
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: "#1750eb",
    },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: "#067d17",
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.propertyName)],
      color: "#00627a",
    },
    {
      tag: [t.constant(t.variableName), t.standard(t.variableName), t.propertyName],
      color: "#871094",
    },
    {
      tag: [t.meta, t.annotation],
      color: "#9e880d",
    },
    {
      tag: t.tagName,
      color: "#0033b3",
    },
    {
      tag: t.attributeName,
      color: "#174ad4",
    },
    {
      tag: t.attributeValue,
      color: "#067d17",
    },
    {
      tag: [t.heading, t.strong],
      color: "#080808",
      fontWeight: "bold",
    },
    {
      tag: t.emphasis,
      fontStyle: "italic",
    },
    {
      tag: t.link,
      color: "#006dcc",
      textDecoration: "underline",
    },
    {
      tag: t.invalid,
      color: "#f50000",
    },
  ],
});
