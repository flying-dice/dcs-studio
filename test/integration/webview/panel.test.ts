import { describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { activeColumn, createPanel } from "../../../src/webview/panel";

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
