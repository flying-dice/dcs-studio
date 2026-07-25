import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireWorkspaceFoldersChanged,
  resetVscode,
  seededText,
  seedFile,
  state,
  vscodeMock,
} from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { INSTALL_DIR, SkillsLibrary } from "../../../src/skills/library";

// The adapter behind the Agent Skills panel: it reads the SKILL.md files the
// VSIX bundles, compares them with the copies installed in the user's repo, and
// watches .claude/skills so the panel and nav badge notice edits made outside
// VS Code. The version/status arithmetic is pure and covered in
// core/domain/skillsStatus; what matters here is that the right files are read,
// that installing copies the whole folder rather than just SKILL.md, and that
// the watchers follow the workspace when it changes.

const EXT = "C:\\ext";
const BUNDLED = "C:\\ext\\skills";
const PROJ = "C:\\proj";
const INSTALLED = "C:\\proj\\.claude\\skills";

const skillMd = (version: string, body = "Run the bridge, then eval.") =>
  `---\nname: dcs-studio\ndescription: Build DCS mods.\nversion: ${version}\n---\n\n${body}\n`;

let library: SkillsLibrary;
let changes: number;

function open(): SkillsLibrary {
  library = new SkillsLibrary(vscode.Uri.file(EXT));
  library.onDidChange(() => {
    changes++;
  });
  return library;
}

beforeEach(() => {
  resetVscode({ workspaceFolders: [PROJ] });
  changes = 0;
  seedFile(`${BUNDLED}\\dcs-studio\\SKILL.md`, skillMd("1.2.0"));
});

describe("listing what is bundled", () => {
  it("reads each bundled skill's frontmatter", async () => {
    const skills = await open().list();
    expect(skills).toEqual([
      {
        id: "dcs-studio",
        name: "dcs-studio",
        description: "Build DCS mods.",
        bundledVersion: "1.2.0",
        status: "not-installed",
      },
    ]);
  });

  it("returns nothing when the extension ships no skills folder", async () => {
    // A packaging slip must leave the panel empty, not throw on activation.
    resetVscode({ workspaceFolders: [PROJ] });
    expect(await open().list()).toEqual([]);
  });

  it("ignores loose files and folders without a SKILL.md", async () => {
    // Only <id>/SKILL.md defines a skill; anything else in skills/ is support
    // material and must not show up as a broken card.
    seedFile(`${BUNDLED}\\README.md`, "not a skill");
    seedFile(`${BUNDLED}\\shared\\notes.txt`, "no manifest here");
    const skills = await open().list();
    expect(skills.map((s) => s.id)).toEqual(["dcs-studio"]);
  });

  it("compares against the copy installed in the workspace", async () => {
    seedFile(`${INSTALLED}\\dcs-studio\\SKILL.md`, skillMd("1.0.0"));
    const skills = await open().list();
    expect(skills[0]).toMatchObject({ status: "outdated", installedVersion: "1.0.0" });
    expect(await library.updatesAvailable()).toHaveLength(1);
  });

  it("reports no updates when the installed copy is current", async () => {
    seedFile(`${INSTALLED}\\dcs-studio\\SKILL.md`, skillMd("1.2.0"));
    const lib = open();
    expect((await lib.list())[0]).toMatchObject({ status: "up-to-date" });
    expect(await lib.updatesAvailable()).toEqual([]);
  });

  it("has nothing to install into without a workspace", async () => {
    // Skills live in the user's repo, so with no folder open there is no
    // install target and the panel says so rather than offering the button.
    resetVscode();
    seedFile(`${BUNDLED}\\dcs-studio\\SKILL.md`, skillMd("1.2.0"));
    const lib = open();
    expect((await lib.list())[0]).toMatchObject({ status: "no-workspace" });
    expect(lib.installedUri("dcs-studio")).toBeUndefined();
  });
});

describe("uris", () => {
  it("points at the bundled and installed SKILL.md", () => {
    const lib = open();
    expect(lib.bundledUri("dcs-studio").fsPath).toBe(`${BUNDLED}\\dcs-studio\\SKILL.md`);
    expect(lib.installedUri("dcs-studio")?.fsPath).toContain(INSTALL_DIR.replace("/", "\\"));
  });
});

describe("installing into the workspace", () => {
  it("copies the whole skill folder, not just SKILL.md", async () => {
    // Skills reference sibling files; copying only the manifest installs a
    // skill whose instructions point at files that were never written.
    seedFile(`${BUNDLED}\\dcs-studio\\reference\\api.md`, "# API");
    const uri = await open().install("dcs-studio");

    expect(uri.fsPath).toBe(`${INSTALLED}\\dcs-studio\\SKILL.md`);
    expect(seededText(`${INSTALLED}\\dcs-studio\\SKILL.md`)).toBe(skillMd("1.2.0"));
    expect(seededText(`${INSTALLED}\\dcs-studio\\reference\\api.md`)).toBe("# API");
    expect(changes).toBe(1);
  });

  it("overwrites an older installed copy in place", async () => {
    seedFile(`${INSTALLED}\\dcs-studio\\SKILL.md`, skillMd("1.0.0"));
    const lib = open();
    await lib.install("dcs-studio");
    expect((await lib.list())[0]).toMatchObject({ status: "up-to-date" });
  });

  it("refuses to install with no folder open", async () => {
    resetVscode();
    await expect(open().install("dcs-studio")).rejects.toThrow("Open a folder first");
  });
});

describe("removing", () => {
  it("deletes the installed folder to the trash so it can be recovered", async () => {
    seedFile(`${INSTALLED}\\dcs-studio\\SKILL.md`, skillMd("1.2.0"));
    const lib = open();
    await lib.remove("dcs-studio");

    expect(state.fsOps).toEqual([
      {
        op: "delete",
        uri: `${INSTALLED}\\dcs-studio`,
        options: { recursive: true, useTrash: true },
      },
    ]);
    expect((await lib.list())[0]).toMatchObject({ status: "not-installed" });
    expect(changes).toBe(1);
  });

  it("does nothing with no folder open", async () => {
    resetVscode();
    await open().remove("dcs-studio");
    expect(state.fsOps).toEqual([]);
  });
});

describe("watching for changes made outside the panel", () => {
  it("watches the install dir in the open folder", () => {
    open();
    expect(state.watchers).toHaveLength(1);
    expect(state.watchers[0].pattern).toMatchObject({ pattern: `${INSTALL_DIR}/**` });
  });

  it.each([
    ["created", (w: (typeof state.watchers)[number]) => w.fireCreate()],
    ["edited", (w: (typeof state.watchers)[number]) => w.fireChange()],
    ["deleted", (w: (typeof state.watchers)[number]) => w.fireDelete()],
  ])("announces a skill file being %s on disk", (_label, fire) => {
    // Agents rewrite their own SKILL.md, and users edit them by hand; without
    // this the panel keeps showing "up to date" for a file that has diverged.
    open();
    fire(state.watchers[0]);
    expect(changes).toBe(1);
  });

  it("does not watch when no folder is open", () => {
    resetVscode();
    open();
    expect(state.watchers).toEqual([]);
  });

  it("follows the workspace when the open folder changes", () => {
    open();
    state.workspaceFolders = [
      { uri: { fsPath: "C:\\other", scheme: "file" }, name: "other", index: 0 },
    ];
    fireWorkspaceFoldersChanged();

    // The old watcher would keep reporting the previous repo's skills.
    expect(state.watchers[0].disposed).toBe(true);
    expect(state.watchers[1].pattern).toMatchObject({ base: state.workspaceFolders[0] });
    expect(changes).toBe(1);
  });

  it("goes quiet once disposed", () => {
    const lib = open();
    const watcher = state.watchers[0];
    lib.dispose();

    expect(watcher.disposed).toBe(true);
    fireWorkspaceFoldersChanged();
    expect(changes).toBe(0);
  });
});
