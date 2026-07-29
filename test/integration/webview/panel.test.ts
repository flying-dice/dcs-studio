import { describe, expect, it, vi } from "vitest";
import { type FakeWebviewPanel, resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { activeColumn, createPanel, disposeWithPanel } from "../../../src/webview/panel";

// The capabilities every panel in this extension is created with, asserted in
// the one place they are now decided (#51). Ten panels used to hand-write this
// object; the reason it was worth extracting is that it is a security decision
// — what a webview may execute, and where it may read from — and a decision
// made in ten places can drift in nine of them without anything noticing.

const EXT = "C:\\ext";
const context = () =>
  ({ extensionUri: vscode.Uri.file(EXT), subscriptions: [] }) as unknown as vscode.ExtensionContext;

describe("createPanel", () => {
  it("enables scripts and pins resource access to media/, and nothing wider", () => {
    resetVscode();
    createPanel(context(), "dcsStudio.test", "Test", vscode.ViewColumn.One);
    const panel = state.panels[0];

    expect(panel.options).toEqual({
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(vscode.Uri.file(EXT), "media")],
    });
  });

  it("retains context so a hidden panel does not lose live state", () => {
    // Not cosmetic: these panels hold a console buffer, a half-filled manifest
    // form and in-flight install progress. Without this, switching tabs
    // re-runs the webview from scratch and the user loses what they were doing.
    resetVscode();
    createPanel(context(), "dcsStudio.test", "Test", vscode.ViewColumn.One);
    expect(state.panels[0].options).toMatchObject({ retainContextWhenHidden: true });
  });

  it("gives every panel the extension icon", () => {
    resetVscode();
    createPanel(context(), "dcsStudio.test", "Test", vscode.ViewColumn.One);
    expect(state.panels[0].iconPath).toEqual(
      vscode.Uri.joinPath(vscode.Uri.file(EXT), "media", "icon.png"),
    );
  });

  it("passes a full show-options object through untouched", () => {
    // The manifest form opens beside its document without taking the caret;
    // collapsing this parameter to a bare column would steal focus mid-keystroke.
    resetVscode();
    const showOptions = { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true };
    createPanel(context(), "dcsStudio.form", "Form", showOptions);

    expect(state.panels[0].showOptions).toEqual(showOptions);
  });
});

// The closing half of the same extraction (#51). Ten panels hand-wrote the same
// four-step teardown, and the steps they had grown on top of it — a poll timer,
// a log tailer, a callback on a longer-lived launcher — are exactly the ones a
// missed step leaves running against a webview that is gone. The order is the
// contract, so it is asserted here rather than re-guessed per panel.
describe("disposeWithPanel", () => {
  /** A panel plus the double behind it — the tests need both views of it. */
  function open(): { panel: vscode.WebviewPanel; fake: FakeWebviewPanel } {
    resetVscode();
    const panel = createPanel(context(), "dcsStudio.test", "Test", vscode.ViewColumn.One);
    return { panel, fake: state.panels[0] };
  }

  it("runs the panel's own teardown when the panel closes", () => {
    const { panel, fake } = open();
    let closed = 0;
    disposeWithPanel(panel, () => {
      closed++;
    });

    expect(closed).toBe(0);
    fake.dispose();
    expect(closed).toBe(1);
  });

  it("drops every subscription in the bag, last registered first", () => {
    // The bag is what stops a closed panel's listeners firing for the rest of
    // the session — the leak the per-panel copies existed to prevent.
    const { panel, fake } = open();
    const dropped: string[] = [];
    const bag = disposeWithPanel(panel, () => {});
    bag.push({ dispose: () => dropped.push("first") }, { dispose: () => dropped.push("second") });

    fake.dispose();

    expect(dropped).toEqual(["second", "first"]);
    expect(bag).toHaveLength(0);
  });

  it("runs teardown before the bag is drained", () => {
    // Teardown reaches for things the subscriptions can also be holding — a
    // tailer, a poll timer — so it has to run while the panel is still whole.
    const { panel, fake } = open();
    const order: string[] = [];
    const bag = disposeWithPanel(panel, () => order.push("teardown"));
    bag.push({ dispose: () => order.push("subscription") });

    fake.dispose();

    expect(order).toEqual(["teardown", "subscription"]);
  });

  it("closes the panel itself without running teardown twice", () => {
    // Teardown is followed by panel.dispose(), and we are inside the panel's
    // own dispose event when it runs. A second pass would double every step.
    const { panel, fake } = open();
    let closed = 0;
    disposeWithPanel(panel, () => {
      closed++;
    });

    fake.dispose();

    expect(fake.disposed).toBe(true);
    expect(closed).toBe(1);
  });

  it("collects the subscriptions the vscode event signature pushes into it", async () => {
    // Panels hand the bag to onDidReceiveMessage as its third argument rather
    // than pushing by hand; that path has to land in the same bag, or the
    // message handler outlives the panel that answers for it.
    const { panel, fake } = open();
    let handled = 0;
    const bag = disposeWithPanel(panel, () => {});
    panel.webview.onDidReceiveMessage(() => handled++, null, bag);

    fake.dispose();
    await fake.webview.receive({ type: "anything" });

    expect(handled).toBe(0);
  });
});

describe("activeColumn", () => {
  it("opens beside whatever the user is looking at", () => {
    resetVscode();
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = {
      viewColumn: vscode.ViewColumn.Two,
    };
    expect(activeColumn()).toBe(vscode.ViewColumn.Two);
  });

  it("falls back to the first column when no editor is open", () => {
    resetVscode();
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = undefined;
    expect(activeColumn()).toBe(vscode.ViewColumn.One);
  });
});
