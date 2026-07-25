// Shared preview harness — stubs `acquireVsCodeApi()` so a real webview
// script (media/*.js, loaded unmodified) can run standalone in a plain
// browser tab or under Playwright. Load this FIRST, before any fixture and
// before the real media/*.js: the load order across every preview is
//   harness.js -> fixture (sets globals / registers host replies)
//   -> CSS links -> #app/#toast mounts -> real media/*.js
// because the webview IIFE runs (and may synchronously post messages)
// the instant its <script> tag executes.
//
// - window.__sentMessages: every message the webview posts to the host,
//   in order. Read by tests/helpers.ts#sentMessages / expectSent.
// - window.__host.onPost(fn): a fixture registers fn to react to webview
//   posts (e.g. answer the boot "refresh"/"ready" request, or run a scripted
//   fake-install flow). Multiple handlers may be registered; all run.
// - window.__host.receive(msg): dispatch a host -> webview "message" event.
//   Used by fixtures for scripted replies and by tests (via hostSend) to
//   inject host pushes directly.
// - window.__toast(html): tiny visual log for the human dev-loop preview;
//   a no-op if the page has no #toast element.
(() => {
  const sent = [];
  window.__sentMessages = sent;

  const postHandlers = [];
  window.__host = {
    receive(msg) {
      window.dispatchEvent(new MessageEvent("message", { data: msg }));
    },
    onPost(fn) {
      postHandlers.push(fn);
    },
  };

  // Per-page-load state store (mirrors vscode.getState()/setState() — a
  // fresh value every navigation, which is what gives tests isolation for
  // free without needing to clear anything between specs).
  //
  // Held as JSON *text*, because the real pair serialises across the webview
  // boundary: a panel that persists a live array it keeps mutating (console.js
  // does exactly that with `history`) must not see later mutations in what it
  // stored, or a dropped/mis-ordered persist() is invisible to the suite and a
  // non-cloneable value passes here and throws in VS Code.
  //
  // Starts *undefined*, like a real webview that has never called setState:
  // every panel guards with `vscode.getState() || {}` precisely because of
  // that first load, and a harness that handed back `{}` would never exercise
  // it. `?state=<url-encoded JSON>` seeds a restored session instead — that's
  // the reload path where a panel re-opens on the page/tab/history it left
  // off at, and it arrives already serialised. See
  // tests/helpers.ts#openPreview({ state }).
  let state = new URLSearchParams(location.search).get("state") || undefined;

  window.acquireVsCodeApi = () => ({
    getState: () => (state === undefined ? undefined : JSON.parse(state)),
    setState: (v) => {
      state = JSON.stringify(v);
    },
    postMessage: (m) => {
      sent.push(m);
      // Fan out in a LATER task. A real host cannot reply re-entrantly — the
      // reply crosses the webview boundary — so a panel that mutates state
      // after posting (a request-id counter, a busy flag, a pending-map
      // insert) must be observed post-mutation here too, or a
      // reply-correlation bug passes green in the suite and fails in VS Code.
      // sent[] stays synchronous, so expectSent is unaffected.
      for (const fn of postHandlers) setTimeout(() => fn(m), 0);
    },
  });

  window.__toast = (html) => {
    const wrap = document.getElementById("toast");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "t";
    el.innerHTML = html;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  };
})();
