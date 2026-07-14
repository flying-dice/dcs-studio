// Shared Playwright helpers for the previews/ webview harnesses.
//
// data-testid conventions used across media/*.js (see previews/harness.js
// for the harness these testids are read through):
//   - kebab-case, no view prefix — each webview is an isolated document, so
//     e.g. "install-btn" is unambiguous without a "skills-" or
//     "marketplace-" prefix.
//   - suffixes: -btn, -input, -select, -link, -badge, -row, -card.
//   - repeated items pair a stable testid with an existing data-*
//     discriminator: skill-card+data-id, nav-item+data-id,
//     toc-link+data-page, mod-card+data-repo, manifest rows via
//     data-sec/-idx/-key already on the row/input.
//   - empty/error/progress states get their own testid (list-empty,
//     list-error, install-error, install-progress, ...) so assertions never
//     depend on copy text.
import { type Page, expect } from "@playwright/test";

/**
 * Navigate to a previews/<name>.html harness and start collecting console
 * errors / uncaught page errors. Returns the (live, growing) array — assert
 * `errors.length === 0` after driving the page to catch anything the real
 * media/*.js script throws once it's running against fixture data.
 */
export async function openPreview(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(`/previews/${name}.html`);
  return errors;
}

/** Every message the webview has posted to the (stubbed) host so far, in order. */
export async function sentMessages(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__sentMessages);
}

/**
 * Wait until a message matching `partial` (shallow key/value subset) has
 * been posted. Uses expect.poll because some posts are debounced — the
 * manifest form's `edit` message fires 200ms after the last keystroke, so
 * reading __sentMessages immediately after typing will miss it.
 */
export async function expectSent(page: Page, partial: Record<string, unknown>): Promise<void> {
  await expect
    .poll(async () => {
      const msgs = await sentMessages(page);
      return msgs.some((m) => m && Object.entries(partial).every(([k, v]) => m[k] === v));
    }, { message: `expected a sent message matching ${JSON.stringify(partial)}` })
    .toBe(true);
}

/** Inject a host -> webview message (dispatches the "message" event the real extension host would send). */
export async function hostSend(page: Page, msg: unknown): Promise<void> {
  await page.evaluate((m) => (window as any).__host.receive(m), msg);
}
