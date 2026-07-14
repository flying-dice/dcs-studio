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
  // fresh object every navigation, which is what gives tests isolation for
  // free without needing to clear anything between specs).
  let state = {};

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
