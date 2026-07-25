import { describe, expect, it } from "vitest";
import { psArgs, psQuote } from "../../../src/core/domain/powershell";

// The argv two adapters launch powershell.exe with. Asserted as whole vectors,
// like cliArgs: what matters is not that some flag is present but that the
// exact list is, because the pair drifted apart while each adapter kept its own
// copy — and the flag that went missing went missing from the elevated call.

describe("psQuote", () => {
  it("wraps a value in single quotes", () => {
    expect(psQuote(String.raw`C:\Users\pilot`)).toBe(String.raw`'C:\Users\pilot'`);
  });

  it("doubles an embedded single quote rather than backslash-escaping it", () => {
    // PowerShell's single-quoted literal has exactly one metacharacter, and a
    // backslash is not it — `\'` would end the string and leave the rest of the
    // path as code.
    expect(psQuote("O'Brien")).toBe("'O''Brien'");
    expect(psQuote(String.raw`D:\Mods\O'Brien's Skins`)).toBe(
      String.raw`'D:\Mods\O''Brien''s Skins'`,
    );
  });

  it("leaves every other shell metacharacter alone", () => {
    // Nothing expands inside single quotes: `$`, backtick and `"` are literal,
    // so escaping them would corrupt a legitimate path.
    expect(psQuote('$env:x `n "q" ; rm')).toBe(`'$env:x \`n "q" ; rm'`);
  });

  it("survives an empty string", () => {
    expect(psQuote("")).toBe("''");
  });
});

describe("psArgs.command", () => {
  it("runs a script with no profile, no prompts and no execution policy", () => {
    expect(psArgs.command("Get-Item x")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Item x",
    ]);
  });
});

describe("psArgs.elevatedCommand", () => {
  const argv = psArgs.elevatedCommand("New-Item -Path 'x'");

  it("carries the same base flags on the launcher as a plain command", () => {
    expect(argv.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
  });

  it("passes the same base flags through to the elevated child", () => {
    // The drift this module exists to prevent: -NonInteractive was on the
    // non-elevated call and missing from this one, which is the call with no
    // console to answer a prompt on.
    expect(argv[5]).toContain(`@("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass"`);
  });

  it("waits for the elevated child so the exit code means something", () => {
    // Without -Wait the launcher returns before the child has done anything and
    // a refused UAC prompt reports success.
    expect(argv[5]).toContain("-Wait");
    expect(argv[5]).toContain("-Verb RunAs");
  });

  it("quotes the inner script so its own quotes cannot end it early", () => {
    expect(psArgs.elevatedCommand("Write-Host 'hi'")[5]).toContain(`'Write-Host ''hi'''`);
  });

  it("hides the elevated window", () => {
    expect(argv[5]).toContain("-WindowStyle Hidden");
  });
});
