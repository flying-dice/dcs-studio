// @ts-nocheck
// Shared webview helpers — a single browser-global (window.dcsUi) loaded before
// every panel's own script (see src/webview/html.ts and previews/*.html). Pure,
// DOM-free formatting/escaping/markdown plus the install-manifest transparency
// renderers and icon paths that were previously copy-pasted across media/*.js.
(() => {
  // HTML-escape for interpolation into innerHTML / attribute values. Superset of
  // every panel's former local esc(): escapes & < > " ' (the last two matter for
  // quoted attributes and apostrophes in copy).
  function esc(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  // Human byte size ("—" for none): 1.5 KB, 240 MB…
  function formatBytes(n) {
    if (!n || n <= 0) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = n,
      i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  // Relative "released N ago" recency from an ISO date (a trust signal). Falls
  // back to the raw date for anything older than a year, and "" when absent.
  function formatRecency(iso) {
    if (!iso) return "";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return "released today";
    if (days === 1) return "released yesterday";
    if (days < 30) return `released ${days} days ago`;
    if (days < 60) return "released last month";
    if (days < 365) return `released ${Math.floor(days / 30)} months ago`;
    return `released ${new Date(then).toISOString().slice(0, 10)}`;
  }

  // A deterministic initials avatar (data: URI) for when a real avatar 404s.
  function initialsAvatar(name) {
    const initials = name
      .split(/[\s/-]+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="8" fill="#3a3d41"/><text x="50%" y="54%" font-size="18" fill="#c8c8c8" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }

  // Tiny markdown → HTML renderer (headings, lists, code fences, inline code /
  // bold / italic / links, blockquotes). Escapes everything first.
  function renderMarkdown(src) {
    if (!src) return "";
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    let html = "",
      inCode = false,
      inList = false;
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (inCode) {
          html += "</code></pre>";
          inCode = false;
        } else {
          if (inList) {
            html += "</ul>";
            inList = false;
          }
          html += "<pre><code>";
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        html += `${esc(line)}\n`;
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)/);
      if (h) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
        continue;
      }
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (/^\s*>\s?/.test(line)) {
        html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`;
        continue;
      }
      if (line.trim() === "") continue;
      html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += "</ul>";
    if (inCode) html += "</code></pre>";
    return html;
  }

  // ── Shared inline-SVG path data (the wrapper <svg> stays per-panel so each
  // keeps its own sizing/stroke; only the identical `d`-path bodies live here). ──
  const iconPaths = {
    // The GitHub mark (marketplace sign-in + My Mods "view on GitHub").
    github:
      '<path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/>',
    // A four-arc refresh/update glyph.
    refresh:
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    // The settings gear (sidebar Settings row + New Project rust template tile).
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    // A tray-arrow download glyph (console export toolbar + product Install).
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  };

  // ── Install-manifest transparency (issue #12): the risk maps + the two shared
  // renderers (badge strip + script-execution notice) the Marketplace product
  // page and My Mods both use. Class names / test-ids / icons differ per surface
  // and are passed in; the DOM shape and the maps are shared. ──
  const RISK_LABEL = {
    "links-files": "links files",
    "runs-executable": "runs executable",
    "pre-sanitize-script": "pre-sanitize script",
  };
  // Which risk flags get the orange (warning) treatment vs. the neutral badge.
  const RISK_WARN = { "runs-executable": true, "pre-sanitize-script": true };

  // The compact risk-flag strip. `o`: { wrapClass, wrapTestid, badgeClass,
  // badgeTestid, warnIcon, okIcon }. Returns "" when there are no known risks.
  function riskBadges(view, o) {
    if (!view?.known || !view.risks.length) return "";
    const badges = view.risks
      .map(
        (r) =>
          `<span class="${o.badgeClass}${RISK_WARN[r] ? " warn" : ""}" data-testid="${o.badgeTestid}" data-risk="${esc(r)}">${
            RISK_WARN[r] ? o.warnIcon : o.okIcon || ""
          }${esc(RISK_LABEL[r] || r)}</span>`,
      )
      .join("");
    return `<div class="${o.wrapClass}" data-testid="${o.wrapTestid}">${badges}</div>`;
  }

  // The "Script Execution Notice" alert. The title + Learn-more button (data-docs
  // "sandbox") are identical across surfaces; the body copy differs and is passed
  // in. `o`: { wrapClass, wrapTestid, headClass, icon, body, linkClass, learnTestid }.
  function sanitizeNotice(o) {
    return `<div class="${o.wrapClass}" data-testid="${o.wrapTestid}">
      <div class="${o.headClass}">${o.icon} Script Execution Notice</div>
      ${o.body}
      <button class="${o.linkClass}" data-testid="${o.learnTestid}" data-docs="sandbox">Learn more about script sanitization</button>
    </div>`;
  }

  // The bridge status-dot class shared by the console status line and the
  // sidebar footer. `connected`: any bridge is up; `running`: a mission is live.
  // (Each surface keeps its own label copy, sizing and colours.)
  function bridgeDotClass(connected, running) {
    if (!connected) return "dot off";
    return running ? "dot mission" : "dot menu";
  }

  window.dcsUi = {
    esc,
    formatBytes,
    formatRecency,
    initialsAvatar,
    renderMarkdown,
    iconPaths,
    RISK_LABEL,
    RISK_WARN,
    riskBadges,
    sanitizeNotice,
    bridgeDotClass,
  };
})();
