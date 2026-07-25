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
   * raises the UAC prompt. `-Wait` is what makes the outer process's exit code
   * mean something: without it the launcher returns before the elevated child
   * has done anything, and a failed elevation reports success.
   */
  elevatedCommand: (script: string): string[] => {
    const inner = BASE_FLAGS.map((f) => `"${f}"`).join(",");
    return psArgs.command(
      `Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru ` +
        `-WindowStyle Hidden -ArgumentList @(${inner},"-Command", ${psQuote(script)});`,
    );
  },
};
