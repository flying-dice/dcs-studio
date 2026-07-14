// @ts-nocheck
// Pure logic for the Lua Console Explorer tab — the dcsfiddle-style `_G` tree:
// a hand-rolled glob matcher, the three-mode live filter, match propagation,
// sweep planning/budget math, and the copy-as-JSON serializer. No DOM, no
// vscode. UMD so the exact same code runs in the webview (as the global
// `DcsExplorerCore`) and in a Node/vitest test (via require) — the
// `manifest-core.js` precedent.
//
// Glob subset (deliberately small — no npm deps): `/`-segmented paths;
// `*` and `?` within a segment; `**` spans zero or more whole segments.
// NO character classes and NO brace expansion (documented in the filter
// placeholder). Matching is CASE-INSENSITIVE — a deliberate deviation from
// minimatch, because DCS's own keys mix cases wildly and an exact-case filter
// would be near useless in the field.
/* v8 ignore start */
((root, factory) => {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DcsExplorerCore = api;
})(typeof self !== "undefined" ? self : this, () => {
  /* v8 ignore stop */
  const SWEEP_BUDGET = 200; // max table fetches one Enter-triggered sweep may spend

  // Escape a literal run (everything that is not a wildcard) for use in a RegExp.
  function escapeLiteral(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Compile one path SEGMENT pattern (`*`/`?` wildcards, case-insensitive) to a
  // RegExp anchored over the whole segment.
  function segRegExp(seg) {
    let out = "^";
    for (const ch of seg) {
      if (ch === "*") out += "[^/]*";
      else if (ch === "?") out += "[^/]";
      else out += escapeLiteral(ch);
    }
    return new RegExp(`${out}$`, "i");
  }

  function segMatch(seg, pat) {
    return segRegExp(pat).test(seg);
  }

  function splitSegs(s) {
    return s.split("/").filter((p) => p.length > 0);
  }

  // Recursive segment matcher with `**` support. `partial` lets the PATTERN
  // extend beyond the PATH (used by the sweep: a shallow node whose path is a
  // prefix of the pattern is "on the way" to a deeper match).
  function matchFrom(pSegs, qSegs, pi, qi, partial) {
    while (qi < qSegs.length) {
      if (qSegs[qi] === "**") {
        // Collapse consecutive `**`.
        while (qi + 1 < qSegs.length && qSegs[qi + 1] === "**") qi++;
        if (qi === qSegs.length - 1) return true; // trailing ** swallows the rest
        for (let k = pi; k <= pSegs.length; k++) {
          if (matchFrom(pSegs, qSegs, k, qi + 1, partial)) return true;
        }
        return false;
      }
      if (pi >= pSegs.length) return partial; // path ran out; pattern remains
      if (!segMatch(pSegs[pi], qSegs[qi])) return false;
      pi++;
      qi++;
    }
    return pi === pSegs.length; // both exhausted together = a clean match
  }

  // Does `path` match `pattern`? `opts.partial` = prefix (sweep) semantics;
  // `opts.matchBase` = a slash-free pattern matches the basename only.
  function globMatch(path, pattern, opts) {
    opts = opts || {};
    if (opts.matchBase && pattern.indexOf("/") === -1) {
      const segs = splitSegs(path);
      const base = segs.length ? segs[segs.length - 1] : "";
      return segMatch(base, pattern);
    }
    return matchFrom(splitSegs(path), splitSegs(pattern), 0, 0, !!opts.partial);
  }

  const GLOB_CHARS = /[*?]/;

  // The three live-filter modes:
  //   contains "/"  → glob over the FULL path (`_G/db/Units` style)
  //   has * or ?    → glob against the BASENAME
  //   otherwise     → case-insensitive substring over the full path
  function pathMatchesFilter(path, filter) {
    if (!filter) return true;
    if (filter.indexOf("/") !== -1) return globMatch(path, filter, {});
    if (GLOB_CHARS.test(filter)) return globMatch(path, filter, { matchBase: true });
    return path.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
  }

  // Post-order walk: a node is `matched` if it matches the filter itself OR any
  // descendant does, so the ancestors of a deep match stay visible. An empty
  // filter matches everything (nothing hidden). Mutates `node.matched`.
  function annotateMatches(node, filter) {
    let childMatched = false;
    const kids = node.children || [];
    for (const c of kids) {
      if (annotateMatches(c, filter)) childMatched = true;
    }
    node.matched = pathMatchesFilter(node.path, filter) || childMatched;
    return node.matched;
  }

  function canSweep(filter) {
    return !!filter && filter.indexOf("/") !== -1;
  }

  // The deepest tree level a sweep of `pattern` should descend to. Each literal
  // segment costs one level; each `**` costs `wildcardDepth` (the
  // dcsStudio.explorerWildcardDepth setting) so an unbounded `**` can't run away.
  function sweepMaxDepth(pattern, wildcardDepth) {
    const d = typeof wildcardDepth === "number" ? wildcardDepth : 1;
    let depth = 0;
    for (const seg of splitSegs(pattern)) depth += seg === "**" ? d : 1;
    return depth;
  }

  // Should the sweep fetch (expand) the closed table node at `path`/`depth`?
  // Only when it is shallower than the budget depth AND its path is a prefix of
  // the pattern (partial glob) — i.e. it lies on the way toward a match.
  function shouldSweepFetch(path, depth, pattern, maxDepth) {
    return depth < maxDepth && globMatch(path, pattern, { partial: true });
  }

  // The `/`-joined child path; the root is always "_G".
  function childPath(parent, name) {
    return parent ? `${parent}/${name}` : name;
  }

  function stripQuotes(s) {
    if (
      typeof s === "string" &&
      s.length >= 2 &&
      s.charAt(0) === '"' &&
      s.charAt(s.length - 1) === '"'
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  // One node → a plain JS value for the copy-as-JSON action. A loaded table
  // becomes a nested object of its children; an unexpanded table keeps its
  // "table (N)" preview; scalars are coerced from their Lua preview text;
  // functions carry their resolved signature when known.
  function valueToJson(node) {
    switch (node.type) {
      case "table":
        if (node.loaded && node.children) {
          const obj = {};
          for (const c of node.children) obj[c.key] = valueToJson(c);
          return obj;
        }
        return node.value;
      case "number": {
        const n = Number(node.value);
        return Number.isNaN(n) ? node.value : n;
      }
      case "boolean":
        return node.value === "true";
      case "nil":
        return null;
      case "string":
        return stripQuotes(node.value);
      case "function":
        return node.signature || node.value;
      default:
        return node.value;
    }
  }

  // The children of a (loaded) node as a plain object, keyed by child name —
  // what the copy button writes to the clipboard.
  function childrenToJson(node) {
    const obj = {};
    for (const c of node.children || []) obj[c.key] = valueToJson(c);
    return obj;
  }

  // "name(a, b, c)" — the resolved (or arity-preview) function signature line.
  function signatureDisplay(name, params) {
    return `${name}(${params || ""})`;
  }

  return {
    SWEEP_BUDGET,
    escapeLiteral,
    segMatch,
    globMatch,
    pathMatchesFilter,
    annotateMatches,
    canSweep,
    sweepMaxDepth,
    shouldSweepFetch,
    childPath,
    valueToJson,
    childrenToJson,
    signatureDisplay,
  };
  /* v8 ignore next */
});
