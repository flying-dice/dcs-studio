// Maps file names to one of the vendored IntelliJ Platform icons (see
// $lib/icons/jetbrains) rendered by FileIcon.svelte. DCS formats map onto the
// nearest JetBrains glyph — missions/campaigns are zips, tracks/models are
// binary blobs, textures are images — and Lua gets its own tile since it is
// the language of DCS modding.
export const FOLDER_ICON = "folder";
export const DEFAULT_FILE_ICON = "anyType";

/** Exact-name matches (lowercased) take precedence over extensions. */
const BY_NAME: Record<string, string> = {
  "dcs-studio.toml": "dcsManifest",
  ".gitignore": "gitignore",
  ".gitattributes": "gitignore",
  ".editorconfig": "editorConfig",
  "license": "text",
};

const BY_EXT: Record<string, string> = {
  // ── DCS ──
  lua: "lua",
  miz: "archive",
  cmp: "archive",
  trk: "binaryData",
  edm: "binaryData",
  dds: "image",
  tga: "image",
  // ── code ──
  js: "javaScript",
  jsx: "javaScript",
  ts: "javaScript",
  tsx: "javaScript",
  html: "html",
  xhtml: "html",
  svelte: "html",
  css: "css",
  sql: "sql",
  // ── data / config ──
  json: "json",
  jsonc: "json",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  ini: "config",
  cfg: "config",
  conf: "config",
  env: "config",
  properties: "properties",
  csv: "csv",
  tsv: "csv",
  // ── docs ──
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
  rst: "text",
  // ── media ──
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  bmp: "image",
  webp: "image",
  ico: "image",
  svg: "image",
  ogg: "binaryData",
  wav: "binaryData",
  mp3: "binaryData",
  flac: "binaryData",
  mp4: "binaryData",
  avi: "binaryData",
  mkv: "binaryData",
  mov: "binaryData",
  // ── archives / binaries ──
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  gz: "archive",
  tar: "archive",
  exe: "binaryData",
  dll: "binaryData",
  bin: "binaryData",
  dat: "binaryData",
  pdf: "binaryData",
  // ── shell ──
  sh: "shell",
  ps1: "shell",
  bat: "shell",
  cmd: "shell",
  // ── misc ──
  ttf: "font",
  otf: "font",
  woff: "font",
  woff2: "font",
  patch: "patch",
  diff: "patch",
};

/** Icon base name for a file, e.g. `fileIconFor("init.lua") === "lua"`. */
export function fileIconFor(name: string): string {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return DEFAULT_FILE_ICON;
  return BY_EXT[lower.slice(dot + 1)] ?? DEFAULT_FILE_ICON;
}
