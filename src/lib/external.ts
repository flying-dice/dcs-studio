// Opening links outside the app. A bare `<a href>` click inside the Tauri
// webview navigates the whole app away from the editor — markdown hover/doc
// links must instead open in the OS browser (or a new tab in a plain browser).

import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Open `url` outside the app: the OS default browser under Tauri, a new tab
 *  in a plain browser (vite dev, Playwright). */
export async function openExternal(url: string): Promise<void> {
  // Test seam (issue #32): the e2e-lang suite drives the REAL app, where this
  // opens the OS browser via the Tauri opener — a side effect CDP cannot
  // observe. An injected probe lets the suite record what WOULD open instead.
  // Production never sets it, so this is inert outside the test.
  const probe = (globalThis as { __dcsOpenExternal__?: (u: string) => void })
    .__dcsOpenExternal__;
  if (probe) {
    probe(url);
    return;
  }
  if (isTauri()) {
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Rust's primitive types — they get an exact docs page; everything else falls
 *  back to a docs search. */
const RUST_PRIMITIVES = new Set([
  "bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "usize",
  "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64",
]);

/** Turn a non-URL hover link into a Rust docs URL. rust-analyzer resolves most
 *  intra-doc links (`` [`u64`] ``) to full `doc.rust-lang.org` URLs, but the
 *  ones it can't resolve arrive as the bare item name (`` ` u64 ` ``, `Vec`,
 *  `std::vec::Vec`). Map those to the docs so the link still goes somewhere
 *  useful instead of nowhere. Returns `null` for anything that isn't a plausible
 *  Rust item. */
function rustDocUrl(href: string): string | null {
  // The href arrives percent-encoded (`%60%20u64%20%60`); decode, then drop the
  // backticks/brackets/spaces rust-analyzer leaves around an unresolved name.
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    /* malformed escape — fall back to the raw href */
  }
  const name = decoded.replace(/[`<>\s]/g, "").split("::").pop() ?? "";
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  return RUST_PRIMITIVES.has(name)
    ? `https://doc.rust-lang.org/std/primitive.${name}.html`
    : `https://doc.rust-lang.org/std/index.html?search=${encodeURIComponent(name)}`;
}

/** Shared core: intercept every link click inside `el` so a bare `<a href>`
 *  never navigates the Tauri webview out of the app. An `http(s)`/`mailto` href
 *  opens externally ({@link openExternal}); any other href is handed to
 *  `resolveOther`, whose result (a URL to open, or `null` to swallow) decides
 *  the rest. The container is *content*, not navigation, so the default click
 *  is always prevented. */
function interceptLinkClicks(
  el: HTMLElement,
  resolveOther: (href: string) => string | null,
): void {
  el.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    const target = /^(https?|mailto):/i.test(href) ? href : resolveOther(href);
    if (target) void openExternal(target);
  });
}

/** Link handling for rendered hover/doc cards (rust-analyzer): `http(s)`/`mailto`
 *  opens externally; an unresolved rust-analyzer doc link — a bare item name
 *  that would otherwise navigate the webview to `localhost/<href>` and 404 —
 *  opens the Rust docs; anything else is swallowed. */
export function openLinksExternally(el: HTMLElement): void {
  interceptLinkClicks(el, rustDocUrl);
}

/** Link handling for rendered prose (Marketplace READMEs, Help → Guides):
 *  `http(s)`/`mailto` opens externally; everything else — in-page `#fragment`
 *  anchors and relative links — is swallowed rather than mis-routed, because
 *  prose carries none of the rust-analyzer doc-link semantics above. */
export function openContentLinksExternally(el: HTMLElement): void {
  interceptLinkClicks(el, () => null);
}
