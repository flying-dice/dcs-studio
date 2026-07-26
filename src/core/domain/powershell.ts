// PowerShell quoting and the argv every `powershell.exe` invocation is launched
// with. Two adapters shell out to PowerShell — the linker (elevated symlink
// fallback) and the shortcut writer (WScript.Shell .lnk) — and both had their
// own copy of the escaper and their own hand-written flag list.
//
// The copies had already drifted: the shortcut path passed `-NonInteractive`
// and the linker path did not, on the one call that runs ELEVATED, where a host
// that decides to prompt has no console to prompt on. That is the failure mode
// this module exists to make impossible: the flags are stated once, as a value
// a test can assert whole, the way `cliArgs.ts` does for gh/git/7-Zip.
//
// Escaping matters here beyond tidiness. Both call sites interpolate real
// filesystem paths — a mod's install destination, the user's profile directory
// — into a script string that PowerShell then parses. Inside a single-quoted
// PowerShell string the only metacharacter is the quote itself, escaped by
// doubling; nothing else needs handling, and no expansion happens. That is why
// single quotes, not double, and why this is the whole rule.

/** A string as a PowerShell single-quoted literal: no expansion, quotes doubled. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Flags shared by every invocation, elevated or not:
// - NoProfile      a user's $PROFILE must not run, or change behaviour
// - NonInteractive nothing here can answer a prompt; a prompt is a hang
// - ExecutionPolicy Bypass  these scripts are built here, never read from disk
const BASE_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"] as const;

export const psArgs = {
  /** Run `script` in this process's PowerShell. */
  command: (script: string): string[] => [...BASE_FLAGS, "-Command", script],

  /**
   * Run `script` in an ELEVATED PowerShell, via a non-elevated launcher that
   * raises the UAC prompt.
   *
   * Three separate things have to happen for the caller to learn that an
   * elevated write failed, and `Start-Process` does none of them by default:
   *
   * - `-Wait` makes the launcher block until the child is done. Without it the
   *   launcher returns immediately and there is no status to read yet.
   * - `-PassThru` returns the child process object. `Start-Process` never sets
   *   `$LASTEXITCODE` and never adopts the child's status as its own, so this
   *   object is the *only* route to the child's exit code — and discarding it
   *   means the launcher exits 0 whenever it managed to dispatch, however the
   *   elevated work went. That reports a failed link as a successful one, and
   *   the caller writes it to the ledger.
   * - `exit $p.ExitCode` propagates it.
   *
   * `-ErrorActionPreference Stop` covers the other half: if the launcher itself
   * fails — a declined UAC prompt is the ordinary case — `Start-Process` raises
   * rather than returning a process, and only under `Stop` does that terminate
   * the launcher with a non-zero code. The `-not $p` guard is the belt to that
   * brace: this string cannot be executed by the test suite (Linux CI, no UAC),
   * so the one path that must never silently report success does not rest on a
   * single assumption about PowerShell's error semantics.
   */
  elevatedCommand: (script: string): string[] => {
    const inner = BASE_FLAGS.map((f) => `"${f}"`).join(",");
    return psArgs.command(
      `$ErrorActionPreference='Stop'; ` +
        `$p = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru ` +
        `-WindowStyle Hidden -ArgumentList @(${inner},"-Command", ${psQuote(script)}); ` +
        `if (-not $p) { exit 1 }; exit $p.ExitCode;`,
    );
  },
};
