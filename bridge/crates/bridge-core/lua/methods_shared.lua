-- Shared JSON-RPC method metadata for the debug_*/repl_* methods that BOTH
-- bridges register. The description/params/result strings were duplicated
-- word-for-word between gui_methods.lua and mission_methods.lua (only the
-- handler bodies legitimately differ) — this is the single source of truth for
-- them, so a wording change lands in one place and the two OpenRPC goldens can't
-- drift apart.
--
-- Delivered by lib.rs `load_register_methods`, which PREPENDS this chunk to each
-- bridge's register_methods source: the following `return function(router, deps)`
-- closes over `SHARED_META` as a local. The headless OpenRPC golden test loads
-- the SAME composed source, so the checked-in documents stay pinned to it.
--
-- Two kinds of entries:
--   * Fully identical across both bridges (description + params) — used directly
--     as add_method's metadata argument on each side.
--   * repl_* entries carry only the shared `description`; the params differ (the
--     GUI bridge adds an `env` selector the single-environment mission bridge has
--     no use for), so each file spreads the description into its own params.
local SHARED_META = {
  -- Fully identical: used as-is by both bridges.
  debug_state = {
    description = "Poll the session: { paused, running, snapshot?, error? }. Also the liveness signal that keeps a held pause alive.",
  },
  debug_expand = {
    description = "Lazily expand a variables/scope ref from the pause snapshot or the inspector.",
    params = { { name = "ref", type = "number", required = true } },
  },
  debug_eval = {
    description = "Evaluate an expression in a paused frame (locals → upvalues → globals). A top-level `name = value` assigns for real.",
    params = {
      { name = "frame", type = "number", required = false },
      { name = "expr", type = "string", required = true },
    },
  },
  debug_continue = {
    description = "Resume a paused session: mode continue | step_over | step_into | step_out.",
    params = { { name = "mode", type = "string", required = false } },
  },
  debug_pause = {
    description = "Break at the next line of debugged code (manual pause).",
  },
  debug_stop = {
    description = "Terminate the running chunk (unwinds a runaway/looping run).",
  },
  debug_clear_breakpoints = {
    description = "Drop every breakpoint and condition held by this bridge.",
  },

  -- Shared descriptions only (params differ — the GUI bridge adds `env`).
  repl_inspect = {
    description = "Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.",
  },
  repl_expand = {
    description = "Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.",
  },
  repl_signature = {
    description = "Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.",
  },
  repl_export = {
    description = "Write the full JSON of a value (by ref or expression) to a file under <writedir>Temp\\ and return { path, bytes }.",
  },
}
