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

  it("propagates the elevated child's exit code as the launcher's own", () => {
    // The whole reason -PassThru is on the line. Start-Process sets neither
    // $LASTEXITCODE nor the launcher's exit code, so discarding the process
    // object it hands back means the launcher exits 0 however the elevated work
    // went — and linker.ts maps that to { ok: true }, which SubscriptionService
    // writes to the ledger. A mod would be recorded as enabled with a link that
    // was never created.
    expect(argv[5]).toContain("$p = Start-Process");
    expect(argv[5]).toContain("exit $p.ExitCode");
  });

  it("fails the launcher when the elevation itself never produced a child", () => {
    // A declined UAC prompt: Start-Process raises instead of returning, and
    // only under Stop does that terminate the launcher non-zero. `-not $p`
    // covers the same ground independently, because this string is never
    // executed by the suite — Linux CI has no UAC to decline.
    expect(argv[5]).toContain("$ErrorActionPreference='Stop'");
    expect(argv[5]).toContain("if (-not $p) { exit 1 }");
  });

  it("is exactly this script", () => {
    // The individual assertions above say what each part is for; this one is
    // what actually pins the composition, the way cliArgs pins an argv. Every
    // clause here is load-bearing and the order matters — the capture has to
    // precede the guard, and the guard the propagation.
    expect(psArgs.elevatedCommand("New-Item -Path 'x'")[5]).toBe(
      `$ErrorActionPreference='Stop'; ` +
        `$p = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru ` +
        `-WindowStyle Hidden -ArgumentList @("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command", 'New-Item -Path ''x'''); ` +
        `if (-not $p) { exit 1 }; exit $p.ExitCode;`,
    );
  });

  it("quotes the inner script so its own quotes cannot end it early", () => {
    expect(psArgs.elevatedCommand("Write-Host 'hi'")[5]).toContain(`'Write-Host ''hi'''`);
  });

  it("hides the elevated window", () => {
    expect(argv[5]).toContain("-WindowStyle Hidden");
  });
});
