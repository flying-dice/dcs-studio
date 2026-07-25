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
(function () {
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
  // Starts *undefined*, like a real webview that has never called setState:
  // every panel guards with `vscode.getState() || {}` precisely because of
  // that first load, and a harness that handed back `{}` would never exercise
  // it. `?state=<url-encoded JSON>` seeds a restored session instead — that's
  // the reload path where a panel re-opens on the page/tab/history it left
  // off at. See tests/helpers.ts#openPreview({ state }).
  let state;
  const seed = new URLSearchParams(location.search).get("state");
  if (seed) state = JSON.parse(seed);

  // TODO: clean-code - 0.7 - BOUNDARY: postMessage fans out to host handlers
  // SYNCHRONOUSLY, so a fixture's reply is delivered re-entrantly before
  // postMessage returns — a real host can only reply in a later task. Any panel
  // that mutates state after posting (a request-id counter, a busy flag, a
  // pending-map insert) is asserted against pre-mutation state here and
  // post-mutation state in VS Code, so a reply-correlation bug passes green.
  // console.js and marketplace.js already defer their replies by hand, which
  // shows the divergence was found once and patched locally instead of here.
  // Fix: `for (const fn of postHandlers) setTimeout(() => fn(m), 0)` — sent[]
  // stays synchronous, so expectSent is unaffected.
  //
  // TODO: clean-code - 0.6 - BOUNDARY: getState/setState store the caller's
  // object BY REFERENCE; the real pair serialises. console.js persists a live
  // `history` array it keeps mutating, so webviewState(page) reads it as it is
  // now rather than as it was persisted — a dropped or mis-ordered persist()
  // is invisible, and a non-cloneable value survives here and throws in VS
  // Code. Round-trip through JSON on both ends.
  window.acquireVsCodeApi = function () {
    return {
      getState: () => state,
      setState: (v) => {
        state = v;
      },
      postMessage: (m) => {
        sent.push(m);
        for (const fn of postHandlers) fn(m);
      },
    };
  };

  window.__toast = function (html) {
    const wrap = document.getElementById("toast");
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "t";
    el.innerHTML = html;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  };
})();
