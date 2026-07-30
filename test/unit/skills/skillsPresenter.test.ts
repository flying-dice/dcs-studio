import { describe, expect, it } from "vitest";
import type {
  SkillsConfirm,
  SkillsEffect,
  SkillsInbound,
  SkillsPresenterDeps,
} from "../../../src/core/app/skillsPresenter";
import { SkillsPresenter } from "../../../src/core/app/skillsPresenter";
import type { SkillsHostMessage } from "../../../src/core/app/webviewContract";
import type { SkillInfo } from "../../../src/core/domain/skillsStatus";

// The Agent Skills panel's decision logic, with no `vscode` anywhere — not even
// a double.
//
// The panel's one genuinely dangerous action is installing over a skill file the
// user (or their agent) has edited: the overwrite is unrecoverable, so the gate
// in front of it is asserted per status rather than in aggregate. The rest is the
// payload the screen renders from and the two ways a file is opened, which is a
// distinction the old panel made and nothing but this suite was watching.

const REF = "file:///c%3A/proj/.claude/skills/dcs-studio/SKILL.md";
const BUNDLED = "file:///c%3A/ext/skills/dcs-studio/SKILL.md";

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "dcs-studio",
    name: "dcs-studio",
    description: "",
    bundledVersion: "1.2.0",
    status: "not-installed",
    ...over,
  };
}

interface Harness {
  presenter: SkillsPresenter;
  posted: SkillsHostMessage[];
  effects: SkillsEffect[];
  /** Every dep call that changed the repo, in order. */
  calls: string[];
  /** Every question the presenter asked, exactly as it asked it. */
  asked: SkillsConfirm[];
}

/**
 * A presenter over one skill, a repo that accepts writes, and a user who says
 * yes to everything. Each test narrows whichever of those it is about.
 */
function harness(over: Partial<SkillsPresenterDeps> = {}): Harness {
  const posted: SkillsHostMessage[] = [];
  const effects: SkillsEffect[] = [];
  const calls: string[] = [];
  const asked: SkillsConfirm[] = [];
  const deps: SkillsPresenterDeps = {
    list: async () => [skill()],
    hasWorkspace: () => true,
    install: async (id) => {
      calls.push(`install ${id}`);
      return { ref: REF, label: `.claude\\skills\\${id}\\SKILL.md` };
    },
    remove: async (id) => void calls.push(`remove ${id}`),
    installedRef: () => REF,
    bundledRef: () => BUNDLED,
    // The default user says yes, by pressing the button the presenter itself
    // named; `refusing()` below is the one that dismisses.
    confirm: async (question) => {
      asked.push(question);
      return question.confirmLabel;
    },
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return { presenter: new SkillsPresenter(deps), posted, effects, calls, asked };
}

/** A harness whose user dismisses every modal. */
function refusing(over: Partial<SkillsPresenterDeps> = {}): Harness {
  return harness({ confirm: async () => undefined, ...over });
}

describe("SkillsPresenter — the one message the screen renders from", () => {
  it("carries the list, the install directory and whether there is a repo", async () => {
    const h = harness();
    await h.presenter.refresh();
    expect(h.posted).toEqual([
      { type: "skills", skills: [skill()], installDir: ".claude/skills", hasWorkspace: true },
    ]);
  });

  it("names the install directory from the domain rather than a second spelling", async () => {
    // The webview prints this back at the user as the path to commit, and the
    // library installs into it. One value, one home.
    const h = harness();
    await h.presenter.refresh();
    expect(h.posted[0]).toMatchObject({ installDir: ".claude/skills" });
  });

  it("reports no repo when no folder is open", async () => {
    // The webview swaps every Install button for an "open a folder" note off
    // exactly this, so it is the difference between a usable panel and a lying one.
    const h = harness({ hasWorkspace: () => false });
    await h.presenter.refresh();
    expect(h.posted[0]).toMatchObject({ hasWorkspace: false });
  });

  it("re-reads whether a folder is open on every push, not once", async () => {
    // The panel outlives a workspace change; a value captured at construction
    // would leave the cards permanently in whichever state the panel opened in.
    let open = false;
    const h = harness({ hasWorkspace: () => open });
    await h.presenter.refresh();
    open = true;
    await h.presenter.refresh();
    expect(h.posted.map((m) => m.hasWorkspace)).toEqual([false, true]);
  });

  it("answers the webview's boot handshake", async () => {
    // `media/skills.js` posts `refresh` at load, which is why this panel cannot
    // lose its opening state to the load race (cf. cards 22-24).
    const h = harness();
    await h.presenter.handle({ type: "refresh" });
    expect(h.posted).toHaveLength(1);
  });
});

describe("SkillsPresenter — the overwrite gate", () => {
  it("installs a fresh skill without asking", async () => {
    const h = harness({ list: async () => [skill({ status: "not-installed" })] });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual(["install dcs-studio"]);
  });

  it("installs a version update without asking", async () => {
    // An outdated copy the user has not edited carries nothing to lose, and a
    // prompt in front of the panel's most common action would train them past it.
    const h = harness({
      list: async () => [skill({ status: "outdated", installedVersion: "1.0.0" })],
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual(["install dcs-studio"]);
  });

  it("confirms before overwriting a locally-edited skill, naming the version", async () => {
    const h = harness({
      list: async () => [skill({ status: "modified", installedVersion: "1.2.0" })],
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.asked).toEqual([
      {
        message:
          'The installed "dcs-studio" skill has local edits. Overwrite them with the bundled v1.2.0?',
        confirmLabel: "Overwrite",
      },
    ]);
    expect(h.calls).toEqual(["install dcs-studio"]);
  });

  it("does not overwrite when the user gives any answer but the confirm button", async () => {
    // The overwrite is unrecoverable, so a dismissed modal — which is what
    // `undefined` is — has to mean no, and so does any other button that might
    // ever be added beside it.
    const h = refusing({
      list: async () => [skill({ status: "modified", installedVersion: "1.2.0" })],
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.calls).toEqual([]);

    const other = harness({
      list: async () => [skill({ status: "modified", installedVersion: "1.2.0" })],
      confirm: async () => "Cancel",
    });
    await other.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(other.calls).toEqual([]);
  });

  it("refreshes nothing when the overwrite was refused", async () => {
    // Nothing changed, and a redraw would make it look as though something had.
    const h = refusing({
      list: async () => [skill({ status: "modified", installedVersion: "1.2.0" })],
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.posted).toEqual([]);
  });

  it("installs an id the list does not know without prompting", async () => {
    // No state to consult means no edits to protect. A skill that vanished from
    // the catalogue between the render and the click must still be installable.
    const h = harness({ list: async () => [] });
    await h.presenter.handle({ type: "install", id: "other" });
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual(["install other"]);
  });

  it("consults the state by id rather than taking the first skill", async () => {
    const h = harness({
      list: async () => [
        skill({ id: "a", status: "modified", installedVersion: "1.0.0" }),
        skill({ id: "b", status: "not-installed" }),
      ],
    });
    await h.presenter.handle({ type: "install", id: "b" });
    expect(h.asked).toEqual([]);
  });
});

describe("SkillsPresenter — what an install tells the user", () => {
  it("names where the file landed and offers to open it", async () => {
    const h = harness();
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.effects).toEqual([
      {
        kind: "installed",
        message:
          "Skill installed to .claude\\skills\\dcs-studio\\SKILL.md — commit it with your repo.",
        ref: REF,
      },
    ]);
  });

  it("uses the workspace-relative label the shell handed it, not the ref", async () => {
    // The ref is a uri the shell round-trips; showing it to the user would put
    // `file:///c%3A/...` in a toast that is asking them to commit a file.
    const h = harness();
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    const installed = h.effects[0] as { message: string };
    expect(installed.message).not.toContain("file://");
  });

  it("reports a failure and still refreshes the list", async () => {
    // A failed install may have left the repo partly written, and the list is how
    // the user finds out — so the refresh is outside the try, deliberately.
    const h = harness({
      install: async () => {
        throw new Error("read-only workspace");
      },
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.effects).toEqual([{ kind: "installFailed", error: "read-only workspace" }]);
    expect(h.posted).toHaveLength(1);
  });

  it("renders a failure that was thrown as something other than an Error", async () => {
    const h = harness({
      install: async () => {
        throw "nope";
      },
    });
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.effects).toEqual([{ kind: "installFailed", error: "nope" }]);
  });

  it("refreshes after a successful install too", async () => {
    const h = harness();
    await h.presenter.handle({ type: "install", id: "dcs-studio" });
    expect(h.posted).toHaveLength(1);
  });
});

describe("SkillsPresenter — opening a skill file", () => {
  it("opens the installed copy as the user's own file", async () => {
    const h = harness();
    await h.presenter.handle({ type: "open", id: "dcs-studio" });
    expect(h.effects).toEqual([{ kind: "openInstalled", ref: REF }]);
  });

  it("asks for the bundled copy as a peek, which is a different request", async () => {
    // Not a flag on one effect: the installed copy is the user's to edit and
    // takes a tab, the bundled one is the extension's and must not.
    const h = harness();
    await h.presenter.handle({ type: "viewBundled", id: "dcs-studio" });
    expect(h.effects).toEqual([{ kind: "viewBundled", ref: BUNDLED }]);
  });

  it("does nothing when there is no installed copy to open", async () => {
    // With no repo there is nowhere for an installed skill to be, and the button
    // that sends this is only drawn for a skill that reported one — so a message
    // that arrives anyway is a stale document, and silence is the honest answer.
    const h = harness({ installedRef: () => undefined });
    await h.presenter.handle({ type: "open", id: "dcs-studio" });
    expect(h.effects).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("still offers the bundled copy when nothing is installed", async () => {
    // The bundled file ships in the extension, so View bundled is the one action
    // that works with no folder open at all.
    const h = harness({ installedRef: () => undefined, hasWorkspace: () => false });
    await h.presenter.handle({ type: "viewBundled", id: "dcs-studio" });
    expect(h.effects).toEqual([{ kind: "viewBundled", ref: BUNDLED }]);
  });
});

describe("SkillsPresenter — removing a skill", () => {
  it("confirms, naming the repo path it would delete, then removes and refreshes", async () => {
    const h = harness();
    await h.presenter.handle({ type: "remove", id: "dcs-studio" });
    expect(h.asked).toEqual([
      {
        message: 'Remove the "dcs-studio" skill from .claude/skills/dcs-studio in your repo?',
        confirmLabel: "Remove",
      },
    ]);
    expect(h.calls).toEqual(["remove dcs-studio"]);
    expect(h.posted).toHaveLength(1);
  });

  it("keeps the skill, and refreshes nothing, when the user declines", async () => {
    const h = refusing();
    await h.presenter.handle({ type: "remove", id: "dcs-studio" });
    expect(h.calls).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("asks before removing, never after", async () => {
    // The delete is the irreversible half; a confirm that arrived second would be
    // a notification pretending to be a question.
    const order: string[] = [];
    const h = harness({
      confirm: async (q) => {
        order.push("ask");
        return q.confirmLabel;
      },
      remove: async () => void order.push("remove"),
    });
    await h.presenter.handle({ type: "remove", id: "dcs-studio" });
    expect(order).toEqual(["ask", "remove"]);
  });
});

describe("SkillsPresenter — message guards", () => {
  it("ignores every action that names no skill", async () => {
    // The id comes out of a `data-id` attribute, so a stale document can post
    // without one. Each of the four is a no-op rather than an action on
    // "undefined".
    const h = harness();
    for (const type of ["install", "open", "viewBundled", "remove"] as const) {
      await h.presenter.handle({ type });
      await h.presenter.handle({ type, id: "" });
    }
    expect(h.calls).toEqual([]);
    expect(h.effects).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("does nothing for a message type it does not declare", async () => {
    const h = harness();
    await h.presenter.handle({ type: "skills" } as unknown as SkillsInbound);
    expect(h.posted).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});
