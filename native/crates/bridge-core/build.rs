// mlua `module` mode never links Lua into the cdylib — DCS provides the
// symbols at load time (on Windows via the LUA_LIB import-lib pin in
// .cargo/config.toml, which also satisfies the unit-test link). Unit tests are
// ordinary executables, so elsewhere they must link a real Lua 5.1 themselves:
// on the Linux CI runner that is Debian's PUC liblua5.1 (same 5.1 ABI DCS
// ships), installed by the rust job (issue #28). `rustc-link-arg-tests` can't
// express this (cargo rejects it — unit tests in a cdylib are not a `[[test]]`
// target), so link the lib crate-wide on non-Windows: the test binaries get
// what they need, and the only other artifact is a Linux .so that never ships.
fn main() {
    if std::env::var_os("CARGO_CFG_WINDOWS").is_none() {
        println!("cargo::rustc-link-lib=dylib=lua5.1");
    }
}
