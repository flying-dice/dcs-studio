import { describe, expect, it } from "vitest";
import { isBrowsableUrl } from "../../../src/core/domain/externalUrl";

// The allowlist a link posted by a webview is measured against. The marketplace
// document renders third-party README markdown, so the URL behind an
// `openExternal` message is attacker-choosable; these cases are the shapes that
// turn `vscode.env.openExternal` into something other than "show a web page".

describe("isBrowsableUrl — accepts", () => {
  it("ordinary web links", () => {
    expect(isBrowsableUrl("https://github.com/owner/repo")).toBe(true);
    expect(isBrowsableUrl("http://example.com/docs?a=1#b")).toBe(true);
  });

  it("mail links, which a README may legitimately carry", () => {
    expect(isBrowsableUrl("mailto:someone@example.com")).toBe(true);
  });

  it("a scheme in any case, since schemes are case-insensitive", () => {
    // The URL parser lowercases the scheme; the allowlist must not be fooled
    // into rejecting a valid link or (worse) into a case-only bypass.
    expect(isBrowsableUrl("HTTPS://example.com")).toBe(true);
    expect(isBrowsableUrl("HtTpS://example.com")).toBe(true);
  });
});

describe("isBrowsableUrl — rejects", () => {
  it("command:, which would run an editor command with chosen arguments", () => {
    expect(isBrowsableUrl('command:workbench.action.terminal.sendSequence?["rm -rf"]')).toBe(false);
  });

  it("file: and vscode:, which open local paths and editor targets", () => {
    expect(isBrowsableUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isBrowsableUrl("vscode://ms-vscode.node-debug/launch")).toBe(false);
  });

  it("script and data schemes", () => {
    expect(isBrowsableUrl("javascript:alert(1)")).toBe(false);
    expect(isBrowsableUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("anything that is not a URL at all", () => {
    // An unparseable target is never something the user asked to visit.
    expect(isBrowsableUrl("")).toBe(false);
    expect(isBrowsableUrl("not a url")).toBe(false);
    expect(isBrowsableUrl("//example.com")).toBe(false);
    expect(isBrowsableUrl("/Scripts/Hooks")).toBe(false);
  });
});
