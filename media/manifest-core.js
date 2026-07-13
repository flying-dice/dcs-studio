// @ts-nocheck
// Pure dcs-studio.toml parse/emit/resolve — no DOM, no vscode. UMD so the same
// code runs in the webview (as a global) and in a Node test (via require). Schema
// mirrors dcs-studio-project/src/manifest.rs; parsing is deliberately tolerant
// (unknown sections/keys ignored on the modeled side), matching the Rust parser.
//
// Sections the form does NOT model ([format], [lints], [release], [test], and
// any future ones) are captured VERBATIM into `model.extras` and re-emitted, so
// editing through the form never drops them. Comments inside modeled sections
// are not preserved (a v1 limitation — the real app uses toml_edit for that).
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DcsManifestCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const ROOT_TOKENS = ["{SavedGames}", "{GameInstall}"];
  const MODELED_ARRAYS = ["install", "dependencies", "requires_module"];

  function emptyModel() {
    return {
      project: { name: "", version: "0.1.0", author: "", description: "" },
      install: [],
      dependencies: [],
      requires_module: [],
      extras: [], // verbatim blocks for sections the form doesn't model
    };
  }

  function parseVal(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (/^'.*'$/.test(v)) return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    return v;
  }

  function parseToml(text) {
    const m = emptyModel();
    if (!text) return m;
    let cur = null;
    let sec = null;
    let extra = null;
    const flush = () => {
      if (extra && extra.join("").trim()) m.extras.push(extra.join("\n").replace(/\s+$/, ""));
      extra = null;
    };
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim();
      const aa = t.match(/^\[\[(.+?)\]\]$/);
      const a = t.match(/^\[(.+?)\]$/);
      if (aa || a) {
        const name = (aa ? aa[1] : a[1]).trim();
        const modeled = aa ? MODELED_ARRAYS.includes(name) : name === "project";
        flush();
        if (modeled) {
          if (aa) {
            if (name === "install") (cur = { source: "", dest: "" }), m.install.push(cur);
            else if (name === "dependencies")
              (cur = { id: "", name: "", version: "", optional: false }), m.dependencies.push(cur);
            else (cur = { id: "", name: "" }), m.requires_module.push(cur);
          } else cur = m.project;
          sec = "modeled";
        } else {
          extra = [raw]; // capture the header + body verbatim
          sec = "extra";
          cur = null;
        }
        continue;
      }
      if (sec === "extra") {
        extra.push(raw);
        continue;
      }
      if (sec === "modeled" && cur) {
        const line = t.replace(/^#.*$/, "");
        if (!line) continue;
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
        if (kv) cur[kv[1]] = parseVal(kv[2].trim());
      }
      // Lines before any section (e.g. a leading comment) are dropped in v1.
    }
    flush();
    return m;
  }

  function q(s) {
    return '"' + String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  function emitToml(m) {
    const L = [];
    L.push("[project]");
    L.push(`name = ${q(m.project.name)}`);
    if (m.project.version) L.push(`version = ${q(m.project.version)}`);
    if (m.project.author) L.push(`author = ${q(m.project.author)}`);
    if (m.project.description) L.push(`description = ${q(m.project.description)}`);
    // Unmodeled [project] keys (template, dcs_min_version, …) pass through
    // verbatim so editing through the form never drops them.
    for (const k of Object.keys(m.project)) {
      if (["name", "version", "author", "description"].includes(k)) continue;
      const v = m.project[k];
      L.push(typeof v === "string" ? `${k} = ${q(v)}` : `${k} = ${v}`);
    }
    for (const r of m.install) L.push("", "[[install]]", `source = ${q(r.source)}`, `dest = ${q(r.dest)}`);
    for (const d of m.dependencies) {
      L.push("", "[[dependencies]]", `id = ${q(d.id)}`);
      if (d.name) L.push(`name = ${q(d.name)}`);
      if (d.version) L.push(`version = ${q(d.version)}`);
      if (d.optional) L.push("optional = true");
    }
    for (const r of m.requires_module) {
      L.push("", "[[requires_module]]", `id = ${q(r.id)}`);
      if (r.name) L.push(`name = ${q(r.name)}`);
    }
    let out = L.join("\n") + "\n";
    if (m.extras && m.extras.length) out += "\n" + m.extras.join("\n\n") + "\n";
    return out;
  }

  function splitDest(dest) {
    for (const t of ROOT_TOKENS) {
      if (dest.startsWith(t)) return { root: t, rest: dest.slice(t.length).replace(/^\//, "") };
    }
    return { root: "{SavedGames}", rest: dest.replace(/^\//, "") };
  }

  function winJoin(base, rest) {
    const b = base.replace(/[\\/]+$/, "");
    const r = rest.replace(/\//g, "\\").replace(/^\\+/, "");
    return r ? `${b}\\${r}` : b;
  }

  function resolveDest(dest, roots) {
    const { root, rest } = splitDest(dest);
    if (root === "{SavedGames}") return winJoin(roots.savedGames, rest);
    if (root === "{GameInstall}") return roots.gameInstall ? winJoin(roots.gameInstall, rest) : null;
    return dest;
  }

  return { ROOT_TOKENS, emptyModel, parseVal, parseToml, q, emitToml, splitDest, winJoin, resolveDest };
});
