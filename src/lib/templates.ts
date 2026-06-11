// Project template metadata for the "New Project" flow. The files
// themselves are rendered by the shared Rust project kit
// (crates/dcs-studio-project) via the `create_project_from_template`
// command — the ids here must match its template ids.
import { FileText, Braces, Cog, type LucideIcon } from "@lucide/svelte";

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    label: "Blank Project",
    description: "Just a dcs-studio.toml manifest — bring your own structure.",
    icon: FileText,
  },
  {
    id: "lua-script",
    label: "Lua Script Mod",
    description: "Scripting mod with an entry point and install mapping.",
    icon: Braces,
  },
  {
    id: "rust-dll",
    label: "Rust DLL Mod",
    description: "Native mod: cargo project building a DLL, deployed via install rules.",
    icon: Cog,
  },
];
