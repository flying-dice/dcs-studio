// The scheme allowlist every webview-supplied link is measured against.
//
// A panel's `openExternal` message is untrusted input in exactly the way an
// install request is: the marketplace document renders a stranger's README
// markdown (`media/shared.js`) into the same page that posts these messages, so
// the URL can be chosen by whoever published the mod. `Uri.parse` has no
// opinion about schemes — it will hand back `file:`, `vscode:` or `command:`
// targets just as happily as `https:`, and `vscode.env.openExternal` on those
// stops being "show the user a web page" and becomes "open a local path" or
// "run an editor command with attacker-chosen arguments".
//
// So the host decides which schemes are openable, rather than the document.
// Only the three a link in a README can legitimately mean are allowed: `http:`,
// `https:` and `mailto:`. Everything else is refused, including a string that
// is not a URL at all — an unparseable target is never something the user asked
// to visit.
//
// Pure string work: NO I/O, no network, no DNS. This says nothing about whether
// the destination is trustworthy, only that opening it hands the user's browser
// or mail client an ordinary link instead of handing the editor a command.

/** Schemes a link from a webview may name. */
const BROWSABLE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * True when `url` parses and names a scheme the user's browser or mail client
 * handles — `http:`, `https:` or `mailto:`.
 *
 * False for everything else, notably `file:`, `vscode:` and `command:`, and for
 * any string that fails to parse as a URL.
 */
export function isBrowsableUrl(url: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return false;
  }
  return BROWSABLE_SCHEMES.has(scheme);
}
