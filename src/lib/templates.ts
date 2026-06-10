// Project templates used by the "New Project" flow. Each template turns a
// project name into a set of files (relative path + contents) that the Rust
// `create_project` command materialises under the new project root. Every
// template emits a `dcs-studio.toml` manifest describing the mod, its file
// manifest, install mappings, and dependencies.
import { FileText, Braces, type LucideIcon } from "@lucide/svelte";
import type { NewFile } from "./api";

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Build the files to write for a project with the given display name. */
  files: (name: string) => NewFile[];
}

/** Folder-safe slug: lowercase, spaces/punctuation → hyphens. */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

/** Valid Lua identifier derived from the project name. */
function luaIdent(name: string): string {
  const id = slugify(name).replace(/-/g, "_");
  return /^[a-z_]/.test(id) ? id : `mod_${id}`;
}

/** Escape a value for use inside a TOML basic (double-quoted) string. */
function toml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const MANIFEST_HEADER = (name: string) => `# dcs-studio.toml — DCS Studio project manifest
# Generated for "${name}". Describes the mod, its files, where each installs
# to, and what it depends on. Install destinations use named roots, resolved
# per-machine at install time:
#   {SavedGames}  → your DCS "Saved Games" folder
#   {GameInstall} → your DCS game install directory
`;

const PROJECT_BLOCK = (name: string, template: string) => `
[project]
name = "${toml(name)}"
version = "0.1.0"
author = ""
description = ""
template = "${template}"
dcs_min_version = "2.9.0"
`;

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    label: "Blank Project",
    description: "Just a dcs-studio.toml manifest — bring your own structure.",
    icon: FileText,
    files: (name) => [
      {
        path: "dcs-studio.toml",
        contents:
          MANIFEST_HEADER(name) +
          PROJECT_BLOCK(name, "blank") +
          `
# Required modules / other mods. Uncomment and edit as needed.
# [[dependencies]]
# id = "F-16C_50"
# name = "F-16C Viper"
# version = "*"
# optional = false

# Install rules: copy matching sources to a destination under a named root.
# [[install]]
# source = "."
# dest = "{SavedGames}/Mods/${slugify(name)}"

# File manifest — tracked project files and their role.
# [[files]]
# path = "main.lua"
# role = "script"
`,
      },
    ],
  },
  {
    id: "lua-script",
    label: "Lua Script Mod",
    description: "Scripting mod with an entry point and install mapping.",
    icon: Braces,
    files: (name) => {
      const slug = slugify(name);
      const ident = luaIdent(name);
      return [
        {
          path: "dcs-studio.toml",
          contents:
            MANIFEST_HEADER(name) +
            PROJECT_BLOCK(name, "lua-script") +
            `
# Required modules / other mods.
[[dependencies]]
id = "F-16C_50"
name = "F-16C Viper"
version = "*"
optional = false

# Install rules: copy matching sources to a destination under a named root.
[[install]]
source = "Scripts/${slug}/"
dest = "{SavedGames}/Scripts/${slug}"

# File manifest — tracked project files and their role.
[[files]]
path = "Scripts/${slug}/main.lua"
role = "script"

[[files]]
path = "README.md"
role = "doc"
`,
        },
        {
          path: `Scripts/${slug}/main.lua`,
          contents: `-- ${name}
-- DCS Studio — Lua Script Mod
--
-- Entry point loaded by DCS. Keep logic small and log liberally; output lands
-- in your DCS log (Saved Games/DCS/Logs/dcs.log).

local ${ident} = {}

${ident}.name    = "${name}"
${ident}.version = "0.1.0"

local function log(msg)
    -- env.info exists inside the mission scripting environment.
    if env and env.info then
        env.info(string.format("[%s] %s", ${ident}.name, msg))
    else
        print(string.format("[%s] %s", ${ident}.name, msg))
    end
end

function ${ident}.start()
    log("loaded v" .. ${ident}.version)
end

${ident}.start()

return ${ident}
`,
        },
        {
          path: "README.md",
          contents: `# ${name}

A DCS (Digital Combat Simulator) Lua script mod, scaffolded by DCS Studio.

## Layout

- \`Scripts/${slug}/main.lua\` — script entry point.
- \`dcs-studio.toml\` — project manifest (metadata, dependencies, install rules).

## Install

Install rules in \`dcs-studio.toml\` map project files to your DCS folders via
named roots (\`{SavedGames}\`, \`{GameInstall}\`), resolved per-machine.
`,
        },
      ];
    },
  },
];

export function templateById(id: string): ProjectTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}
