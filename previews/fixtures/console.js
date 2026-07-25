// Fixture for previews/console.html. Plays the extension host against a small
// fake `_G` so the real media/console.js Explorer tab can be driven end to end
// (inspect -> lazy expand -> signature resolve -> sweep -> copy/export) with no
// VS Code and no DCS.
//
// media/console.js posts {type:"ready"} at load; we answer with a connected
// GUI status and the sweep config. Then it drives the explorer with
// inspect/expand/signature/export messages, which we answer over the fake tree
// below. Refs are handed out per table/function (like the real RT) and re-minted
// on every expand, so a collapse+reopen naturally gets fresh refs.
(function () {
  // Declarative fake tree. `t` = Lua type; tables carry `children`; functions
  // carry `params` (+ optional `native`); scalars carry `v` (the preview text).
  // `many` is a wide table of table children, enough to blow the 200 sweep
  // budget so the cap notice can be asserted.
  const many = {};
  for (let i = 0; i < 220; i++) {
    const id = "c" + String(i).padStart(3, "0");
    many[id] = { t: "table", children: { leaf: { t: "number", v: "0" } } };
  }

  const ROOT = {
    t: "table",
    children: {
      db: {
        t: "table",
        children: {
          Units: {
            t: "table",
            children: {
              Cars: { t: "table", children: { GAZ: { t: "number", v: "1" } } },
              Planes: { t: "table", children: { F15: { t: "number", v: "2" } } },
            },
          },
          Weapons: { t: "table", children: { AIM: { t: "number", v: "3" } } },
        },
      },
      net: { t: "table", children: { host: { t: "string", v: '"local"' } } },
      outText: { t: "function", arity: "function (3 args)", params: "text, displayTime, clearView" },
      now: { t: "function", native: true },
      count: { t: "number", v: "42" },
      title: { t: "string", v: '"mission"' },
      flag: { t: "boolean", v: "true" },
      many: { t: "table", children: many },
      // Failure/edge nodes. The host's answer depends on the node, not on a
      // global switch, so one preview page can show every outcome the tree has
      // to survive: an empty table, a value of a type the icon map doesn't
      // know, a table whose expand fails, a function whose signature can't be
      // resolved, and a table the host refuses to export.
      empty: { t: "table", children: {} },
      nothing: { t: "nil", v: "nil" },
      broken: { t: "table", children: { x: { t: "number", v: "1" } }, failExpand: true },
      brokenFn: { t: "function", arity: "function (1 args)", failSignature: true },
      noexport: { t: "table", children: { y: { t: "number", v: "2" } } },
    },
  };

  // `?scenario=inspect-fail` fails the one round trip that has no per-node
  // handle: reading `_G` itself, which is what a desanitized-but-dead mission
  // bridge does.
  const scenario = new URLSearchParams(location.search).get("scenario") || "";

  let nextRef = 1;
  const refMap = {}; // ref -> node descriptor

  function value(desc) {
    if (desc.t === "table") return "table (" + Object.keys(desc.children || {}).length + ")";
    if (desc.t === "function") return desc.arity || (desc.native ? "function (native)" : "function");
    return desc.v;
  }

  // A descriptor -> the {name,type,value,ref} variable shape the RT hands out.
  function toVar(name, desc) {
    let ref = 0;
    if (desc.t === "table" || desc.t === "function") {
      ref = nextRef++;
      refMap[ref] = desc;
    }
    return { name: name, type: desc.t, value: value(desc), ref: ref };
  }

  // Reply on a fresh tick — like the real host's async round trips, and it
  // keeps the sweep drain (concurrency 1, up to 200 fetches) off one deep
  // synchronous call stack.
  function reply(msg) {
    setTimeout(() => window.__host.receive(msg), 0);
  }

  window.__host.onPost((m) => {
    if (!m) return;
    switch (m.type) {
      case "ready":
        reply({
          type: "status",
          status: { gui: { connected: true, dcsTime: 0 }, mission: { connected: false, dcsTime: null } },
        });
        reply({ type: "explorerConfig", wildcardDepth: 1 });
        return;
      case "eval":
        // A scripted REPL so the Console tab is drivable in the dev preview
        // too. The code decides the reply shape: anything mentioning "error"
        // fails, "print" streams sim output, everything else returns a value.
        if (/error/.test(m.code)) reply({ type: "error", message: "[string \"chunk\"]: " + m.code });
        else if (/print/.test(m.code))
          reply({ type: "print", lines: [{ text: "printed: " + m.code }] });
        else reply({ type: "result", value: { echo: m.code, env: m.env } });
        return;
      case "inspect": {
        if (scenario === "inspect-fail") {
          reply({
            type: "inspectResult",
            id: m.id,
            env: m.env,
            expr: m.expr,
            ok: false,
            err: "attempt to index a nil value",
          });
          return;
        }
        // The `_G` root itself gets a ref.
        const ref = nextRef++;
        refMap[ref] = ROOT;
        reply({
          type: "inspectResult",
          id: m.id,
          env: m.env,
          expr: m.expr,
          ok: true,
          luaType: "table",
          value: value(ROOT),
          ref: ref,
        });
        return;
      }
      case "expand": {
        const desc = refMap[m.ref];
        if (desc && desc.failExpand) {
          reply({ type: "expandResult", nodeId: m.nodeId, ok: false, err: "ref no longer valid" });
          return;
        }
        const variables = [];
        if (desc && desc.t === "table") {
          for (const name of Object.keys(desc.children || {})) variables.push(toVar(name, desc.children[name]));
        }
        reply({ type: "expandResult", nodeId: m.nodeId, ok: true, variables: variables });
        return;
      }
      case "signature": {
        const desc = refMap[m.ref];
        if (desc && desc.t === "function" && !desc.failSignature) {
          reply({ type: "signatureResult", reqId: m.reqId, ok: true, params: desc.params || "", native: !!desc.native });
        } else {
          reply({ type: "signatureResult", reqId: m.reqId, ok: false, err: "stale ref" });
        }
        return;
      }
      case "export":
        reply(
          /noexport/.test(m.label)
            ? { type: "exportDone", reqId: m.reqId, error: "EACCES: permission denied" }
            : { type: "exportDone", reqId: m.reqId, saved: true },
        );
        return;
      case "clearExplorer":
        return; // refs released host-side; nothing to echo
      default:
        window.__toast(`&rarr; posts <b>${m.type}</b>`);
        return;
    }
  });
})();
