import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import type { SkillInfo } from "../../../src/core/domain/skillsStatus";
import type { SkillsLibrary } from "../../../src/skills/library";
import { SkillsPanel } from "../../../src/skills/skillsPanel";

// The Agent Skills panel's SHELL — the wiring this layer is now the only witness
// for. Every decision the panel makes (the overwrite gate, what a failure versus
// a refusal does to the list, whether there is anything to open) moved to
// `SkillsPresenter` and runs with no `vscode` at all in
// `test/unit/skills/skillsPresenter.test.ts`.
//
// What is left here is what only a real editor can be wrong about: that the
// library's uris survive the round trip through the presenter's opaque refs, that
// the modal the presenter asked for is a MODAL, that the installed copy takes a
// tab while the bundled one does not, and card 07's teardown.

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
 * The panel's message handler is wired as `(m) => void this.presenter.handle(m)`,
 * so receive() resolves before the async work behind it finishes. Flush a macro
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

describe("the panel and its document", () => {
  it("opens a scripted webview titled Agent Skills", async () => {
    const panel = await show();
    expect(panel.title).toBe("Agent Skills");
    expect(panel.webview.html).toContain("skills.js");
    expect(panel.webview.html).toContain("Content-Security-Policy");
  });

  it("reveals and refreshes the existing panel instead of opening a second", async () => {
    const panel = await show();
    const before = panel.webview.postedOfType("skills").length;
    SkillsPanel.show(context(), library());
    await flush();

    expect(state.panels).toHaveLength(1);
    // Revealing re-pushes: the repo may have moved while the panel sat behind
    // another tab, and nothing else would tell it.
    expect(panel.webview.postedOfType("skills").length).toBe(before + 1);
  });

  it("clears the singleton on dispose so the next show re-opens", async () => {
    const panel = await show();
    panel.dispose();
    expect(SkillsPanel.current).toBeUndefined();

    await show();
    expect(state.panels).toHaveLength(2);
  });
});

describe("what reaches the presenter", () => {
  it("pushes the list, install dir and workspace state on open", async () => {
    const panel = await show();
    expect(panel.webview.postedOfType("skills").at(-1)).toMatchObject({
      skills,
      installDir: ".claude/skills",
      hasWorkspace: true,
    });
  });

  it("reads the real workspace-folder state, not a constant", async () => {
    resetVscode({});
    const panel = await show();
    expect(panel.webview.postedOfType("skills").at(-1)).toMatchObject({ hasWorkspace: false });
  });

  it("routes a received message to the presenter", async () => {
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
});

describe("the modal the presenter asks for", () => {
  it("asks about an overwrite as a modal with one button", async () => {
    // Modal on purpose: the overwrite is unrecoverable, and a dismissible toast
    // would let it happen behind a user who never saw the question.
    skills = [skill({ status: "modified", installedVersion: "1.2.0" })];
    state.messageReplies.push("Overwrite");
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();

    expect(state.warnings[0]).toContain("has local edits");
    expect(installed).toEqual(["dcs-studio"]);
  });

  it("reports the button that was pressed, so a dismissal is not a yes", async () => {
    // The rule lives in the presenter; what this layer witnesses is that the
    // editor's `undefined` for a dismissed modal actually reaches it.
    skills = [skill({ status: "modified", installedVersion: "1.2.0" })];
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });

    expect(installed).toEqual([]);
  });

  it("asks about a removal the same way, and removes when accepted", async () => {
    state.messageReplies.push("Remove");
    const panel = await show();
    await panel.webview.receive({ type: "remove", id: "dcs-studio" });
    await flush();

    expect(state.warnings[0]).toContain(".claude/skills/dcs-studio");
    expect(removed).toEqual(["dcs-studio"]);
  });
});

describe("the effects", () => {
  it("offers to open the file after installing, and does when accepted", async () => {
    state.messageReplies.push("Open File");
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();

    expect(state.info[0]).toContain(".claude\\skills\\dcs-studio\\SKILL.md");
    expect(state.info[0]).toContain("commit it with your repo");
    // The whole point of the uri round trip: the presenter only ever held an
    // opaque string, and what opens has to be the file the library wrote.
    expect(state.shownDocuments).toEqual(["C:\\proj\\.claude\\skills\\dcs-studio\\SKILL.md"]);
  });

  it("does not open the file when the toast is dismissed", async () => {
    state.messageReplies.push(undefined);
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();
    expect(state.shownDocuments).toEqual([]);
  });

  it("reports an install failure through the one place that reports them", async () => {
    installThrows = new Error("read-only workspace");
    const panel = await show();
    await panel.webview.receive({ type: "install", id: "dcs-studio" });
    await flush();
    expect(state.errors[0]).toBe("Skill install failed: read-only workspace");
  });

  it("opens the installed copy as a document the user keeps", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "open", id: "dcs-studio" });
    await flush();
    expect(state.openedDocuments).toEqual(["C:\\proj\\.claude\\skills\\dcs-studio\\SKILL.md"]);
    expect(state.shownDocuments).toEqual(["C:\\proj\\.claude\\skills\\dcs-studio\\SKILL.md"]);
  });

  it("opens the bundled copy as a preview, so it does not take a tab", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "viewBundled", id: "dcs-studio" });
    await flush();
    expect(state.openedDocuments).toEqual([`${EXT}\\skills\\dcs-studio\\SKILL.md`]);
  });

  it("has nothing to open when the library knows no installed copy", async () => {
    const panel = await show();
    await panel.webview.receive({ type: "open", id: "missing" });
    await flush();
    expect(state.openedDocuments).toEqual([]);
  });
});
