import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { SkillInfo } from "../../../src/core/domain/skillsStatus";
import type { SkillsLibrary } from "../../../src/skills/library";
import { SkillsPanel } from "../../../src/skills/skillsPanel";

// The Agent Skills panel. Its one genuinely dangerous action is installing over
// a skill file the user has edited: that overwrite is unrecoverable, so the
// confirmation rules are asserted per status rather than in aggregate.

const EXT = "C:\\ext";
let skills: SkillInfo[] = [];
let changeListener: (() => void) | undefined;
let installed: string[] = [];
let removed: string[] = [];
let installThrows: Error | undefined;

function library(): SkillsLibrary {
  return {
    list: async () => skills,
    install: async (id: string) => {
      if (installThrows) throw installThrows;
      installed.push(id);
      return vscode.Uri.file(`C:\\proj\\.claude\\skills\\${id}\\SKILL.md`);
    },
    remove: async (id: string) => {
      removed.push(id);
    },
    bundledUri: (id: string) => vscode.Uri.file(`${EXT}\\skills\\${id}\\SKILL.md`),
    installedUri: (id: string) =>
      id === "missing" ? undefined : vscode.Uri.file(`C:\\proj\\.claude\\skills\\${id}\\SKILL.md`),
    onDidChange: (fn: () => void) => {
      changeListener = fn;
      return { dispose: () => (changeListener = undefined) };
    },
  } as unknown as SkillsLibrary;
}

const context = () =>
  ({ extensionUri: vscode.Uri.file(EXT), subscriptions: [] }) as unknown as vscode.ExtensionContext;

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "dcs-studio",
    name: "dcs-studio",
    description: "",
    bundledVersion: "1.2.0",
    status: "not-installed",
    ...over,
  } as SkillInfo;
}

/**
 * The panel's message handler is wired as `(m) => void this.onMessage(m)`, so
 * receive() resolves before the async work behind it finishes. Flush a macro
 * task when asserting on what that work produced.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

async function show() {
  SkillsPanel.show(context(), library());
  await new Promise((r) => setTimeout(r, 0));
  return state.panels[state.panels.length - 1];
}

beforeEach(() => {
  resetVscode({ workspaceFolders: ["C:\\proj"] });
  skills = [skill()];
  installed = [];
  removed = [];
  installThrows = undefined;
  changeListener = undefined;
  SkillsPanel.current = undefined;
});

describe("rendering", () => {
  it("pushes the skill list, install dir and workspace state on open", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("skills").at(-1)).toMatchObject({
      skills,
      installDir: ".claude/skills",
      hasWorkspace: true,
    });
  });

  it("reports no workspace when none is open", async () => {
    // The webview swaps the whole card list for a "open a folder first" note.
    resetVscode({});
    const panel = await show();
    expect(panel.webview.postedOfType("skills").at(-1)).toMatchObject({ hasWorkspace: false });
  });

  it("re-pushes on an explicit refresh", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("skills").length;
    await panel.webview.receive({ type: "refresh" });
    await flush();
    expect(panel.webview.postedOfType("skills").length).toBe(before + 1);
  });

  it("re-pushes when the library reports a change on disk", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("skills").length;
    changeListener?.();
    await flush();
    expect(panel.webview.postedOfType("skills").length).toBe(before + 1);
  });

  it("reveals and refreshes the existing panel instead of opening a second", async () => {
    await show();
    SkillsPanel.show(context(), library());
    await flush();
    expect(state.panels).toHaveLength(1);
  });
});

describe("install", () => {
  it("installs a fresh skill without asking", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });

    expect(installed).toEqual(["dcs-studio"]);
    expect(state.warnings).toEqual([]);
  });

  it("installs a version update without asking", async () => {
    // An outdated copy the user has not edited carries nothing to lose.
    skills = [skill({ status: "outdated", installedVersion: "1.0.0" })];
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });

    expect(installed).toEqual(["dcs-studio"]);
    expect(state.warnings).toEqual([]);
  });

  it("confirms before overwriting a locally-edited skill", async () => {
    skills = [skill({ status: "modified", installedVersion: "1.2.0" })];
    state.messageReplies.push("Overwrite");
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });

    expect(state.warnings[0]).toContain("has local edits");
    expect(state.warnings[0]).toContain("v1.2.0");
    expect(installed).toEqual(["dcs-studio"]);
  });

  it("does not overwrite local edits when the user declines", async () => {
    // The overwrite is unrecoverable, so anything other than an explicit
    // "Overwrite" — including dismissing the modal — must abort.
    skills = [skill({ status: "modified", installedVersion: "1.2.0" })];
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });

    expect(installed).toEqual([]);
  });

  it("offers to open the file after installing, and does when accepted", async () => {
    state.messageReplies.push("Open File");
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();

    expect(state.info[0]).toContain(".claude\\skills\\dcs-studio\\SKILL.md");
    expect(state.info[0]).toContain("commit it with your repo");
    expect(state.shownDocuments).toEqual(["C:\\proj\\.claude\\skills\\dcs-studio\\SKILL.md"]);
  });

  it("does not open the file when the toast is dismissed", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();
    expect(state.shownDocuments).toEqual([]);
  });

  it("surfaces an install failure and still refreshes the list", async () => {
    installThrows = new Error("read-only workspace");
    const panel = await show();
    const before = panel.webview.postedOfType("skills").length;
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();

    expect(state.errors[0]).toBe("Skill install failed: read-only workspace");
    expect(panel.webview.postedOfType("skills").length).toBe(before + 1);
  });

  it("renders a non-Error install failure", async () => {
    installThrows = "nope" as unknown as Error;
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    expect(state.errors[0]).toBe("Skill install failed: nope");
  });

  it("installs an id the library does not know without prompting", async () => {
    // No state to consult means no edits to protect.
    skills = [];
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "other" });
    expect(installed).toEqual(["other"]);
  });
});

describe("open and view", () => {
  it("opens the installed copy in an editor", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "open", id: "dcs-studio" });
    expect(state.shownDocuments).toEqual(["C:\\proj\\.claude\\skills\\dcs-studio\\SKILL.md"]);
  });

  it("does nothing when there is no installed copy to open", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "open", id: "missing" });
    expect(state.shownDocuments).toEqual([]);
  });

  it("opens the bundled copy as a preview, so it does not take a tab", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "viewBundled", id: "dcs-studio" });
    expect(state.openedDocuments).toEqual([`${EXT}\\skills\\dcs-studio\\SKILL.md`]);
  });
});

describe("remove", () => {
  it("confirms before removing, then removes and refreshes", async () => {
    state.messageReplies.push("Remove");
    const panel = await show();
    const before = panel.webview.postedOfType("skills").length;
    await panel.webview.receive({ type: "remove", id: "dcs-studio" });
    await flush();

    expect(state.warnings[0]).toContain(".claude/skills/dcs-studio");
    expect(removed).toEqual(["dcs-studio"]);
    expect(panel.webview.postedOfType("skills").length).toBe(before + 1);
  });

  it("keeps the skill when the user declines", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "remove", id: "dcs-studio" });
    expect(removed).toEqual([]);
  });
});

describe("message guards", () => {
  it("ignores actions with no id and unknown message types", async () => {
    const panel = await show();
    for (const type of ["install", "open", "viewBundled", "remove", "mystery"]) {
      await panel.webview.receive({ type });
    }
    expect(installed).toEqual([]);
    expect(removed).toEqual([]);
    expect(state.shownDocuments).toEqual([]);
  });

  it("clears the singleton on dispose", async () => {
    const panel = await show();
    panel.dispose();
    expect(SkillsPanel.current).toBeUndefined();
  });
});
