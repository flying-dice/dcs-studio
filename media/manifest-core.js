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
// The UMD preamble is environment-selection boilerplate, and only ever one of
// its two halves can run in a given host: under Node `module` is always
// defined, so the browser half is unreachable from the unit layer that owns
// this file's coverage. It is not untested — manifestCoreValues.test.ts
// evaluates this source in a module-less vm context and asserts the API lands
// on the global, which is exactly what a webview <script> tag does. Everything
// the wrapper returns is covered normally below.
/* v8 ignore start */
((root, factory) => {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DcsManifestCore = api;
})(typeof self !== "undefined" ? self : this, () => {
  /* v8 ignore stop */
  const ROOT_TOKENS = ["{SavedGames}", "{GameInstall}"];
  // The array sections the model stores first-class and re-emits. New array
  // sections (a future one) drop in by adding a name here and a create-case
  // below. The pre-release `[[install]]` section is NOT supported: it falls
  // through to `extras` like any unknown section — preserved verbatim, ignored
  // functionally — and publish preflight rejects it (breaking change, 2026-07).
  const MODELED_ARRAYS = ["bundle", "symlink", "requires_module", "entrypoint", "mission_script"];
  // The two run timings a [[mission_script]] may declare; the first is the safe
  // default (sandboxed mission env). "before-sanitize" runs with the full,
  // unsanitized Lua environment — a security-sensitive capability.
  const MISSION_SCRIPT_RUN_ON = ["after-sanitize", "before-sanitize"];

  function emptyModel() {
    return {
      project: { name: "", version: "0.1.0", author: "", description: "" },
      // What gets packed into the release 7z (paths relative to project root).
      bundle: [],
      // Which links are created on enable: source is a path inside the bundle.
      symlink: [],
      requires_module: [],
      // Executable entrypoints the mod can launch as tracked processes.
      entrypoint: [],
      // Lua scripts run at mission start via the managed MissionScripting.lua.
      mission_script: [],
      extras: [], // verbatim blocks for sections the form doesn't model
    };
  }

  /**
   * Parse a single-line TOML inline array of scalars, e.g. `["--min", "-v"]`,
   * into a JS array. Deliberately tolerant (v1): multiline arrays are not
   * supported — the form only ever emits single-line arrays. Each element is
   * run back through parseVal so quoted strings, bools and ints all work.
   */
  function parseArray(v) {
    const inner = v.replace(/^\[/, "").replace(/\]$/, "");
    const out = [];
    const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^,]+?)\s*(?:,|$)/g;
    let m;
    // biome-ignore lint/suspicious/noAssignInExpressions: canonical RegExp.exec loop
    while ((m = re.exec(inner)) !== null) {
      // Standard defensive guard for a global regex loop. Provably unreachable
      // with THIS pattern — every alternative in the capture group requires at
      // least one character, so exec can never return a zero-length match — but
      // kept so the loop stays safe if the pattern is ever relaxed.
      /* v8 ignore next */
      if (m.index === re.lastIndex) re.lastIndex++;
      const tok = m[1].trim();
      if (tok) out.push(parseVal(tok));
    }
    return out;
  }

  function parseVal(v) {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^\[[\s\S]*\]$/.test(v)) return parseArray(v);
    if (/^".*"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    if (/^'.*'$/.test(v)) return v.slice(1, -1);
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    return v;
  }

  // The modeled [project] fields the model guarantees are strings. TOML is
  // typed, so `name = 2024` is a valid integer and `version = 1` a valid one
  // too — but every consumer treats these as text and calls .trim() on them
  // (the form's issues(), publish preflight's computePreflight()), which turns
  // a number or boolean into a TypeError. Normalise once here at the parse
  // boundary rather than defending at each use.
  const PROJECT_TEXT_KEYS = ["name", "version", "author", "description"];

  /**
   * A modeled [project] value as text: a quoted string unquotes as usual, and
   * anything TOML types as a non-string (integer, float, boolean, array) keeps
   * its literal source text. Unmodeled [project] keys deliberately do NOT go
   * through this — they keep their parsed type so emitToml round-trips them.
   */
  function parseProjectText(raw) {
    const v = parseVal(raw);
    return typeof v === "string" ? v : raw;
  }

  function parseToml(text) {
    const m = emptyModel();
    if (!text) return m;
    let cur = null;
    let sec = null;
    let extra = null;
    const flush = () => {
      if (extra?.join("").trim()) m.extras.push(extra.join("\n").replace(/\s+$/, ""));
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
            if (name === "bundle") {
              cur = { path: "" };
              m.bundle.push(cur);
            } else if (name === "symlink") {
              cur = { source: "", dest: "" };
              m.symlink.push(cur);
            } else if (name === "entrypoint") {
              cur = { id: "", name: "", exe: "" };
              m.entrypoint.push(cur);
            } else if (name === "mission_script") {
              cur = { name: "", purpose: "", path: "", run_on: "after-sanitize" };
              m.mission_script.push(cur);
            } else {
              cur = { id: "", name: "" };
              m.requires_module.push(cur);
            }
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
        if (kv) {
          const val = kv[2].trim();
          cur[kv[1]] =
            cur === m.project && PROJECT_TEXT_KEYS.includes(kv[1])
              ? parseProjectText(val)
              : parseVal(val);
        }
      }
      // Lines before any section (e.g. a leading comment) are dropped in v1.
    }
    flush();
    return m;
  }

  function q(s) {
    return (
      '"' +
      String(s == null ? "" : s)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"') +
      '"'
    );
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
    for (const r of m.bundle) L.push("", "[[bundle]]", `path = ${q(r.path)}`);
    for (const r of m.symlink)
      L.push("", "[[symlink]]", `source = ${q(r.source)}`, `dest = ${q(r.dest)}`);
    for (const r of m.requires_module) {
      L.push("", "[[requires_module]]", `id = ${q(r.id)}`);
      if (r.name) L.push(`name = ${q(r.name)}`);
    }
    for (const r of m.entrypoint) {
      L.push("", "[[entrypoint]]", `id = ${q(r.id)}`, `name = ${q(r.name)}`, `exe = ${q(r.exe)}`);
      if (r.args?.length) L.push(`args = [${r.args.map(q).join(", ")}]`);
      if (r.cwd) L.push(`cwd = ${q(r.cwd)}`);
    }
    for (const r of m.mission_script) {
      L.push("", "[[mission_script]]", `name = ${q(r.name)}`);
      if (r.purpose) L.push(`purpose = ${q(r.purpose)}`);
      L.push(`path = ${q(r.path)}`, `run_on = ${q(r.run_on || "after-sanitize")}`);
    }
    let out = `${L.join("\n")}\n`;
    if (m.extras?.length) out += `\n${m.extras.join("\n\n")}\n`;
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
    // splitDest is total — it returns {GameInstall} or defaults to
    // {SavedGames} — so the write dir is the fall-through, not a third case.
    if (root === "{GameInstall}") {
      return roots.gameInstall ? winJoin(roots.gameInstall, rest) : null;
    }
    return winJoin(roots.savedGames, rest);
  }

  return {
    ROOT_TOKENS,
    MISSION_SCRIPT_RUN_ON,
    emptyModel,
    parseVal,
    parseToml,
    q,
    emitToml,
    splitDest,
    winJoin,
    resolveDest,
  };
});
