// E2E: rendered-markdown links (hover cards, the Problems panel) never navigate
// the webview out of the app — web links open externally, an unresolved
// rust-analyzer doc link (a bare item name) opens the Rust docs, the rest are
// swallowed. Exercises `openLinksExternally` directly so it doesn't depend on
// flaky hover/mouse timing.

import { test, expect } from "@playwright/test";

test("card links route externally and resolve unresolved rust doc refs", async ({
  page,
}) => {
  await page.goto("/lab/lua");

  const result = await page.evaluate(async () => {
    const { openLinksExternally } = await import("/src/lib/external.ts");
    const opened: string[] = [];
    // In a plain browser openExternal falls back to window.open — spy on it.
    window.open = ((url: string) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;

    const el = document.createElement("div");
    // hrefs as the markdown renderer emits them (rust-analyzer doc refs arrive
    // percent-encoded: `%60%20u64%20%60` is `` ` u64 ` ``).
    el.innerHTML = [
      '<a href="https://doc.rust-lang.org/std/primitive.u64.html">web</a>',
      '<a href="%60%20u64%20%60">unresolved-primitive</a>',
      '<a href="%60HashMap%60">unresolved-type</a>',
      '<a href="#frag">fragment</a>',
    ].join("");
    document.body.appendChild(el);
    openLinksExternally(el);

    let navigated = false;
    const start = location.href;
    for (const anchor of el.querySelectorAll("a")) {
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      if (location.href !== start) navigated = true;
    }
    return { opened, navigated };
  });

  // Nothing navigated the webview.
  expect(result.navigated).toBe(false);
  // Web link as-is; `u64` → its primitive page; `HashMap` → docs search;
  // the in-page fragment opens nothing.
  expect(result.opened).toEqual([
    "https://doc.rust-lang.org/std/primitive.u64.html",
    "https://doc.rust-lang.org/std/primitive.u64.html",
    "https://doc.rust-lang.org/std/index.html?search=HashMap",
  ]);
});
