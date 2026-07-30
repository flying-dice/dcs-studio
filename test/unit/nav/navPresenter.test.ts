import { describe, expect, it } from "vitest";
import type { NavEffect, NavInbound, NavPresenterDeps } from "../../../src/core/app/navPresenter";
import { NavPresenter } from "../../../src/core/app/navPresenter";
import type { NavHostMessage } from "../../../src/core/app/webviewContract";
import type { DualBridgeStatus } from "../../../src/core/domain/bridgeProtocol";
import type { SkillInfo } from "../../../src/core/domain/skillsStatus";

// The sidebar's decision logic, with no `vscode` anywhere — not even a double.
//
// The sidebar is the longest-lived webview in the extension: registered at
// activation, alive for the whole session, and the first surface a user sees. Its
// rows are static markup the webview owns (`media/nav.js`, driven in Chromium by
// `tests/nav.spec.ts`); what the host decides is what those rows are TOLD, and
// every one of those decisions collapses something richer into something a
// sidebar has room for. Those collapses are what this suite is about.

function status(over: Partial<DualBridgeStatus> = {}): DualBridgeStatus {
  return {
    gui: { connected: false, dcsTime: null },
    mission: { connected: false, dcsTime: null },
    ...over,
  } as DualBridgeStatus;
}

function outdated(id: string): SkillInfo {
  return {
    id,
    name: id,
    description: "",
    bundledVersion: "2.0.0",
    installedVersion: "1.0.0",
    status: "outdated",
  };
}

interface Harness {
  presenter: NavPresenter;
  posted: NavHostMessage[];
  effects: NavEffect[];
}

function harness(over: Partial<NavPresenterDeps> = {}): Harness {
  const posted: NavHostMessage[] = [];
  const effects: NavEffect[] = [];
  const deps: NavPresenterDeps = {
    updatesAvailable: async () => [],
    manifestExists: async () => false,
    post: (msg) => posted.push(msg),
    effect: (e) => effects.push(e),
    ...over,
  };
  return { presenter: new NavPresenter(deps), posted, effects };
}

describe("NavPresenter — the two bridges collapsed into one footer", () => {
  it("reads as connected when only the GUI bridge is up", async () => {
    const h = harness();
    h.presenter.pushStatus(status({ gui: { connected: true, dcsTime: null } } as never));
    expect(h.posted).toEqual([{ type: "status", status: { connected: true, dcsTime: null } }]);
  });

  it("reads as connected when only the mission bridge is up", async () => {
    // Either, not both: a sidebar that went grey because the mission bridge is
    // down while the GUI bridge is answering would be lying about a session the
    // user can already use.
    const h = harness();
    h.presenter.pushStatus(status({ mission: { connected: true, dcsTime: 120 } } as never));
    expect(h.posted).toEqual([{ type: "status", status: { connected: true, dcsTime: 120 } }]);
  });

  it("reads as offline only when neither bridge is up", async () => {
    const h = harness();
    h.presenter.pushStatus(status());
    expect(h.posted).toEqual([{ type: "status", status: { connected: false, dcsTime: null } }]);
  });

  it("shows the mission bridge's clock when it has one", async () => {
    // The pick between the two clocks is `displayTime`'s rule, taken from the
    // domain rather than restated: the mission bridge is the one that knows the
    // mission time, and the GUI bridge's is the fallback.
    const h = harness();
    h.presenter.pushStatus(
      status({
        gui: { connected: true, dcsTime: 7 },
        mission: { connected: true, dcsTime: 213 },
      } as never),
    );
    expect(h.posted[0]).toMatchObject({ status: { dcsTime: 213 } });
  });

  it("falls back to the GUI bridge's clock when the mission bridge has none", async () => {
    const h = harness();
    h.presenter.pushStatus(
      status({
        gui: { connected: true, dcsTime: 7 },
        mission: { connected: true, dcsTime: null },
      } as never),
    );
    expect(h.posted[0]).toMatchObject({ status: { dcsTime: 7 } });
  });

  it("carries a zero time rather than dropping it", async () => {
    // `0` is "at the menu" and the webview tells it apart from a running mission
    // by `> 0`. A presenter that coerced it away would make the footer claim a
    // mission was running.
    const h = harness();
    h.presenter.pushStatus(status({ gui: { connected: true, dcsTime: 0 } } as never));
    expect(h.posted[0]).toMatchObject({ status: { connected: true, dcsTime: 0 } });
  });
});

describe("NavPresenter — the Agent Skills badge", () => {
  it("counts the outdated skills rather than sending them", async () => {
    // The row has space for a number; the badge is hidden entirely at zero. What
    // crosses is the only part the webview can draw.
    const h = harness({ updatesAvailable: async () => [outdated("a"), outdated("b")] });
    await h.presenter.pushSkills();
    expect(h.posted).toEqual([{ type: "skills", updates: 2 }]);
  });

  it("says zero rather than saying nothing when nothing is outdated", async () => {
    // The push is what CLEARS a badge: a skill updated back to current has to
    // un-badge the row, so "no updates" is a message, not silence.
    const h = harness();
    await h.presenter.pushSkills();
    expect(h.posted).toEqual([{ type: "skills", updates: 0 }]);
  });

  it("re-asks the catalogue on every push", async () => {
    let updates: SkillInfo[] = [];
    const h = harness({ updatesAvailable: async () => updates });
    await h.presenter.pushSkills();
    updates = [outdated("a")];
    await h.presenter.pushSkills();
    expect(h.posted).toEqual([
      { type: "skills", updates: 0 },
      { type: "skills", updates: 1 },
    ]);
  });
});

describe("NavPresenter — whether the workspace is already a mod project", () => {
  it("reports a manifest when the workspace has one", async () => {
    const h = harness({ manifestExists: async () => true });
    await h.presenter.pushManifest();
    expect(h.posted).toEqual([{ type: "manifest", hasManifest: true }]);
  });

  it("reports none when it does not", async () => {
    // One boolean behind two rows: "Create a Mod" versus "Edit Project", and
    // whether Publish Mod is on screen at all.
    const h = harness();
    await h.presenter.pushManifest();
    expect(h.posted).toEqual([{ type: "manifest", hasManifest: false }]);
  });

  it("re-asks on every push, because the watcher is what triggers it", async () => {
    let exists = false;
    const h = harness({ manifestExists: async () => exists });
    await h.presenter.pushManifest();
    exists = true;
    await h.presenter.pushManifest();
    expect(h.posted.map((m) => (m as { hasManifest: boolean }).hasManifest)).toEqual([false, true]);
  });
});

describe("NavPresenter — running what a row asks for", () => {
  it("runs the command the clicked row named", async () => {
    const h = harness();
    h.presenter.handle({ type: "run", command: "dcs.marketplace.open" });
    expect(h.effects).toEqual([{ kind: "runCommand", command: "dcs.marketplace.open" }]);
  });

  it("drops a run that names no command", async () => {
    // The command id is a `data-command` attribute the document carries, so a
    // stale or crafted post may have none — and executing "" raises an editor
    // error dialog for something no user asked for.
    const h = harness();
    h.presenter.handle({ type: "run" });
    h.presenter.handle({ type: "run", command: "" });
    expect(h.effects).toEqual([]);
    expect(h.posted).toEqual([]);
  });

  it("does not validate the command beyond its presence", async () => {
    // Deliberate: the rows' command ids are the extension's own contributions and
    // the editor is the thing that knows which exist. A whitelist here would be a
    // second, staler copy of package.json.
    const h = harness();
    h.presenter.handle({ type: "run", command: "dcs.not.a.real.command" });
    expect(h.effects).toEqual([{ kind: "runCommand", command: "dcs.not.a.real.command" }]);
  });

  it("does nothing for a message type it does not declare", async () => {
    const h = harness();
    h.presenter.handle({ type: "status" } as unknown as NavInbound);
    expect(h.effects).toEqual([]);
    expect(h.posted).toEqual([]);
  });
});
