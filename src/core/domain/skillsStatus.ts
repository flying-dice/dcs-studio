// Pure logic behind the Agent Skills status: the YAML-frontmatter mini-parser,
// the dotted-numeric version compare, and the not-installed / up-to-date /
// outdated / modified state machine — all decided from probed text, no I/O.
// The SkillsLibrary adapter reads the bundled and installed SKILL.md files and
// hands their contents here.

/** Where skills install inside the user's repo, relative to the workspace root. */
export const INSTALL_DIR = ".claude/skills";

export type SkillStatus =
  | "no-workspace" // no folder open — nothing to install into
  | "not-installed"
  | "up-to-date"
  | "outdated" // bundled version is newer than the installed copy
  | "modified"; // same (or newer) version but the installed content differs

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  bundledVersion: string;
  installedVersion?: string;
  status: SkillStatus;
}

export interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
}

/** name/description/version out of a `---` YAML frontmatter block (flat keys only). */
export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return {};
  const fm: Frontmatter = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const m = /^(name|description|version):\s*(.*)$/.exec(line);
    if (m) fm[m[1] as keyof Frontmatter] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

/** Dotted-numeric version compare: >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Decide a skill's status from its probed text. `hasWorkspace` is false when no
 * folder is open (nothing to install into); `installedText` is undefined when
 * the skill isn't installed in the workspace.
 */
export function skillInfoFor(
  id: string,
  bundledText: string,
  hasWorkspace: boolean,
  installedText: string | undefined,
): SkillInfo {
  const fm = parseFrontmatter(bundledText);
  const info: SkillInfo = {
    id,
    name: fm.name ?? id,
    description: fm.description ?? "",
    bundledVersion: fm.version ?? "0.0.0",
    status: "not-installed",
  };

  if (!hasWorkspace) {
    info.status = "no-workspace";
    return info;
  }
  if (installedText === undefined) return info; // not-installed

  const installedFm = parseFrontmatter(installedText);
  info.installedVersion = installedFm.version ?? "0.0.0";
  const normalize = (t: string) => t.replace(/\r\n/g, "\n");
  if (compareVersions(info.bundledVersion, info.installedVersion) > 0) {
    info.status = "outdated";
  } else if (normalize(installedText) !== normalize(bundledText)) {
    // Same or newer version but diverged content: the user (or their
    // agent) edited it — don't offer a destructive "update".
    info.status = "modified";
  } else {
    info.status = "up-to-date";
  }
  return info;
}

/**
 * Whether installing over the current status would clobber local edits and so
 * needs a confirm prompt (fresh installs and version updates don't ask).
 */
export function requiresOverwriteConfirm(status: SkillStatus): boolean {
  return status === "modified";
}
