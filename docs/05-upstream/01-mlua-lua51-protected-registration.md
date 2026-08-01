# mlua (Lua 5.1): protect with `lua_cpcall` so no allocation precedes the frame

> **Draft — for the owner to file.** Nothing has been submitted to mlua. This
> page is the argument, written down while the evidence was fresh, so filing it
> is an editing job rather than a re-derivation. Suggested destination: an issue
> on [mlua-rs/mlua](https://github.com/mlua-rs/mlua), Lua 5.1 backend.

## Summary

In mlua's Lua 5.1 backend, a protected call is established by pushing a C
function and then calling `lua_pcall`. The **push allocates**, and it happens
*before* the protected frame exists. If that allocation fails, Lua 5.1 raises
with `L->errorJmp` still null, which means `luaD_throw` hands the state to
`G(L)->panic` and calls `exit(EXIT_FAILURE)`.

Lua 5.1 ships a primitive with no such window: `lua_cpcall`. It builds its C
closure *inside* `luaD_pcall`, after the error jump target is installed. Using
it in mlua's protection setup would close the window while keeping each
protected unit exactly as small and as `Drop`-free as it is today.

## Why it matters where it does

For an ordinary embedding this is a footnote — the allocator is Rust's, and
mlua's `MemoryState::relax_limit_with` grants headroom at precisely this seam,
so an mlua-owned state cannot fail there at all.

It stops being a footnote in **module mode against a host allocator**. Our case
is a Rust `cdylib` loaded into DCS World's Lua 5.1 state: the allocator is the
host's, `relax_limit_with` has nothing to relax, and `exit(EXIT_FAILURE)` closes
the user's flight simulator with no diagnostic. We instrumented the panic path
to at least name ourselves before the process dies
(`bridge/crates/bridge-core/src/lua_panic.rs`); that is evidence, not a fix.

The same shape applies to any module-mode embedding into a host process — a game,
an editor, an application server — where the process is not mlua's to end.

## Where the window is

- `mlua-0.10.5/src/util/error.rs:165` and `:226` — `protect_lua_call` /
  `protect_lua_closure` push the C function, then `lua_pcall` it. The push is
  the allocating call, and it precedes protection.
- `mlua-sys-0.6.8/src/lua51/lua.rs:189` — `lua_cpcall` is already declared in
  the sys crate. In PUC 5.1, `luaD_pcall` installs `L->errorJmp` before
  `f_Ccall` runs, and `f_Ccall` is what pushes the closure. Nothing allocates
  ahead of the frame.

Concretely, in our embedding the reachable instance is
`Lua::create_function` → `lua_pushcfunction` during module registration.

## Why the fix belongs in the binding, not in the embedder

The obvious embedder-side workaround is to wrap the whole registration in one
outer protected frame. We rejected it as **unsound**, and the reason is mlua's
own contract (`mlua-0.10.5/src/util/error.rs:151-155`): the protected closure
"must *not* panic, and since it will generally be longjmping, should not contain
any values that implement `Drop`". mlua wraps each API call in its own tiny
`lua_pcall` exactly so that a longjmp never crosses a Rust frame.

A frame spanning a whole registration inverts that guarantee. The throw would
unwind over hundreds of Rust frames holding `String`s, `Vec`s, live `Table`/
`Function` references, mlua's own `StackGuard` and its state lock — skipping
every destructor. That trades a clean `exit(EXIT_FAILURE)` for a Lua state whose
Rust-side bookkeeping was jumped over: leaked registry entries, a lock never
released, and no evidence at all. A hung or quietly corrupt host is worse than a
host that closes with a log line.

Only mlua can fix this soundly, because only mlua can keep the protected unit
small: `lua_cpcall` at the same seams preserves the one-API-call-per-frame
structure the contract depends on, and closes the window at the same time.

## What a patch has to carry across

Not a one-liner, which is part of why it is filed rather than attempted here:

1. The `error_traceback` message handler currently installed for the `lua_pcall`
   — `lua_cpcall` takes no message-handler index, so the traceback path needs an
   equivalent arrangement.
2. The argument-passing convention. `lua_cpcall` passes a single `void*` to the
   C function; the current shape passes arguments on the stack.
3. Revalidation across every protected call site, on every 5.1-family backend
   the change touches (5.1, LuaJIT).

## Notes for whoever files it

- Reproducing it needs a host allocator that can actually fail at that seam.
  Through mlua's own `set_memory_limit` it is **not** reachable: we swept
  0..400 KB of headroom in 8-byte steps through an allocating registration path
  and every iteration errored cleanly, because `relax_limit_with` makes an
  mlua-owned state immune exactly there
  (`bridge/crates/bridge-core/src/lib.rs`, the sweep and its comment). Say so in
  the report — otherwise the first reviewer response will be a `set_memory_limit`
  test that proves the wrong thing.
- This came out of [dcs-studio#63](https://github.com/flying-dice/dcs-studio/issues/63),
  closed as resolved-by-analysis: our own registration turned out to already run
  under a `pcall` we install (`bridge/hook/DcsStudio.lua`,
  `bridge/crates/bridge-core/lua/gui_methods.lua`), so the remaining exposure is
  general rather than specific to us.
