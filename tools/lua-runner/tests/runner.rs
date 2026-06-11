//! dcs-lua-runner end-to-end: real binary, real Lua 5.1 states, JSON in
//! and out (model: `studio::cli::TestRunner` + its features). Each test
//! writes spec files into a fresh temp dir and drives the built binary —
//! the same seam `dcs-studio-cli test` uses.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Run {
    output: serde_json::Value,
    status: std::process::ExitStatus,
}

fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dcs-lua-runner-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("tests")).expect("temp dir");
    dir
}

/// Write `files` under a fresh root and run the binary with the spec on
/// stdin. Files whose path ends in `.test.lua` are listed in the spec;
/// anything else is written as a plain project file for requires.
fn run_spec(tag: &str, files: &[(&str, &str)]) -> Run {
    let root = temp_root(tag);
    for (path, contents) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("file has a parent")).expect("subdir");
        std::fs::write(&full, contents).expect("write spec file");
    }
    let spec = serde_json::json!({
        "root": root,
        "files": files
            .iter()
            .map(|(path, _)| *path)
            .filter(|path| path.ends_with(".test.lua"))
            .collect::<Vec<_>>(),
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_dcs-lua-runner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn dcs-lua-runner");
    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(spec.to_string().as_bytes())
        .expect("write spec");
    let output = child.wait_with_output().expect("runner completes");
    let _ = std::fs::remove_dir_all(&root);

    let stdout = String::from_utf8_lossy(&output.stdout);
    Run {
        output: serde_json::from_str(&stdout).unwrap_or_else(|e| {
            panic!(
                "runner stdout must be JSON ({e}); stdout: {stdout}; stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        }),
        status: output.status,
    }
}

/// The cases array of the spec's `index`th file.
fn cases(run: &Run, index: usize) -> &Vec<serde_json::Value> {
    run.output["files"][index]["cases"]
        .as_array()
        .expect("cases array")
}

fn case<'a>(run: &'a Run, file: usize, name: &str) -> &'a serde_json::Value {
    cases(run, file)
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("case {name:?} present in {:?}", run.output))
}

#[test]
fn matchers_pass_and_failures_carry_line_numbers() {
    let run = run_spec(
        "matchers",
        &[(
            "tests/matchers.test.lua",
            r#"describe("matchers", function()
  test("the passing set", function()
    expect(2).toBe(2)
    expect({ a = 1, list = { "x" } }).toEqual({ a = 1, list = { "x" } })
    expect("yes").toBeTruthy()
    expect(nil).toBeFalsy()
    expect(nil).toBeNil()
    expect("hello world").toContain("lo wo")
    expect({ "a", "b" }).toContain("b")
    expect(function() error("boom") end).toThrow("boom")
  end)
  test("a failing toBe", function()
    local x = 1 + 1
    expect(x).toBe(3)
  end)
end)
test("top-level test outside any describe", function()
  expect(true).toBeTruthy()
end)
"#,
        )],
    );

    assert!(run.status.success(), "runner exits 0 on failing TESTS");
    assert_eq!(cases(&run, 0).len(), 3);

    let passing = case(&run, 0, "matchers > the passing set");
    assert_eq!(passing["passed"], true);

    let failing = case(&run, 0, "matchers > a failing toBe");
    assert_eq!(failing["passed"], false);
    assert_eq!(failing["message"], "expected 2 to be 3");
    // The line of the expect() call itself, not of the harness.
    assert_eq!(failing["line"], 14);

    let top_level = case(&run, 0, "top-level test outside any describe");
    assert_eq!(top_level["passed"], true);
}

#[test]
fn stub_calls_record_into_dcs_calls_in_order() {
    let run = run_spec(
        "stubs",
        &[(
            "tests/stubs.test.lua",
            r#"test("stubs record every call, in order", function()
  env.info("first")
  trigger.action.outText("hello pilots", 10, false)
  env.warning("second")
  env.error("third")
  local handler = { onEvent = function() end }
  world.addEventHandler(handler)
  world.removeEventHandler(handler)

  expect(#dcs.calls).toBe(6)
  expect(dcs.calls[1].fn).toBe("env.info")
  expect(dcs.calls[1].args[1]).toBe("first")
  expect(dcs.calls[2].fn).toBe("trigger.action.outText")
  expect(dcs.calls[2].args[1]).toBe("hello pilots")
  expect(dcs.calls[2].args[2]).toBe(10)
  expect(dcs.calls[3].fn).toBe("env.warning")
  expect(dcs.calls[4].fn).toBe("env.error")
  expect(dcs.calls[5].fn).toBe("world.addEventHandler")
  expect(dcs.calls[5].args[1]).toBe(handler)
  expect(dcs.calls[6].fn).toBe("world.removeEventHandler")
end)
"#,
        )],
    );

    let only = case(&run, 0, "stubs record every call, in order");
    assert_eq!(only["passed"], true, "stub log spec failed: {:?}", only);
}

#[test]
fn advance_time_fires_in_deadline_order_with_fifo_ties() {
    let run = run_spec(
        "clock",
        &[(
            "tests/clock.test.lua",
            r#"test("deadline order, FIFO on ties, chained scheduling, reschedule, remove", function()
  expect(timer.getTime()).toBe(0)
  local fired = {}
  local function mark(tag)
    return function(args, now)
      table.insert(fired, tag .. "@" .. now)
    end
  end

  -- Insertion order scrambled against deadlines; b1/b2 tie at t=5.
  timer.scheduleFunction(mark("late"), nil, 9)
  timer.scheduleFunction(mark("b1"), nil, 5)
  timer.scheduleFunction(mark("b2"), nil, 5)
  timer.scheduleFunction(mark("early"), nil, 2)

  -- A fired function scheduling INSIDE the window fires the same advance.
  timer.scheduleFunction(function(args, now)
    timer.scheduleFunction(mark("chained"), nil, now + 1)
  end, nil, 3)

  -- Returning a number reschedules (DCS semantics); fires at 4 and 8.
  local repeats = 0
  timer.scheduleFunction(function(args, now)
    repeats = repeats + 1
    table.insert(fired, "repeat@" .. now)
    if repeats < 2 then
      return now + 4
    end
  end, nil, 4)

  -- A removed function never fires.
  local doomed = timer.scheduleFunction(mark("doomed"), nil, 6)
  timer.removeFunction(doomed)

  runner.advanceTime(10)
  expect(timer.getTime()).toBe(10)
  -- chained ties with repeat at t=4 but was scheduled later (during the
  -- advance), so FIFO puts repeat first.
  expect(table.concat(fired, " ")).toBe(
    "early@2 repeat@4 chained@4 b1@5 b2@5 repeat@8 late@9")
end)
test("partial advances leave the future scheduled", function()
  local count = 0
  timer.scheduleFunction(function() count = count + 1 end, nil, timer.getTime() + 10)
  runner.advanceTime(9)
  expect(count).toBe(0)
  runner.advanceTime(1)
  expect(count).toBe(1)
end)
"#,
        )],
    );

    for name in [
        "deadline order, FIFO on ties, chained scheduling, reschedule, remove",
        "partial advances leave the future scheduled",
    ] {
        let result = case(&run, 0, name);
        assert_eq!(result["passed"], true, "{name} failed: {result:?}");
    }
}

#[test]
fn unstubbed_dcs_surface_errors_with_not_stubbed_yet() {
    let run = run_spec(
        "unstubbed",
        &[(
            "tests/unstubbed.test.lua",
            r#"test("an unstubbed DCS global errors", function()
  local _ = coalition.getPlayers(2)
end)
test("an unstubbed member of a stubbed table errors", function()
  timer.setFunctionTime(1, 99)
end)
test("a plain unknown global stays normal Lua nil", function()
  expect(some_random_name).toBeNil()
end)
"#,
        )],
    );

    let global = case(&run, 0, "an unstubbed DCS global errors");
    assert_eq!(global["passed"], false);
    let message = global["message"].as_str().expect("message string");
    assert!(
        message.contains("not stubbed yet: coalition"),
        "got: {message}"
    );

    let member = case(&run, 0, "an unstubbed member of a stubbed table errors");
    assert_eq!(member["passed"], false);
    let message = member["message"].as_str().expect("message string");
    assert!(
        message.contains("not stubbed yet: timer.setFunctionTime"),
        "got: {message}"
    );

    let plain = case(&run, 0, "a plain unknown global stays normal Lua nil");
    assert_eq!(plain["passed"], true, "{plain:?}");
}

#[test]
fn every_file_gets_a_fresh_state() {
    let run = run_spec(
        "fresh",
        &[
            (
                "tests/a.test.lua",
                r#"test("file A pollutes its own state", function()
  LEAKED = "from A"
  env.info("noise from A")
  expect(#dcs.calls).toBe(1)
end)
"#,
            ),
            (
                "tests/b.test.lua",
                r#"test("file B sees none of it", function()
  expect(LEAKED).toBeNil()
  expect(#dcs.calls).toBe(0)
  expect(timer.getTime()).toBe(0)
end)
"#,
            ),
        ],
    );

    assert_eq!(case(&run, 0, "file A pollutes its own state")["passed"], true);
    assert_eq!(case(&run, 1, "file B sees none of it")["passed"], true);
}

#[test]
fn broken_files_report_a_failed_case_never_silence() {
    let run = run_spec(
        "broken",
        &[
            // Top-level runtime error AFTER one test ran: both report.
            (
                "tests/late-boom.test.lua",
                "test(\"ran before the boom\", function() end)\nerror(\"top-level boom\")\n",
            ),
            // A file that does not even parse: one failed (file) case.
            (
                "tests/syntax.test.lua",
                "test(\"never runs\", function( end)\n",
            ),
        ],
    );

    let ran = case(&run, 0, "ran before the boom");
    assert_eq!(ran["passed"], true);
    let boom = case(&run, 0, "(file)");
    assert_eq!(boom["passed"], false);
    assert!(
        boom["message"]
            .as_str()
            .expect("message string")
            .contains("top-level boom")
    );

    // A syntax error yields a single failed (file) case.
    let cases_b = cases(&run, 1);
    assert_eq!(cases_b.len(), 1);
    assert_eq!(cases_b[0]["name"], "(file)");
    assert_eq!(cases_b[0]["passed"], false);
}

#[test]
fn missing_file_is_a_failed_case_and_spec_path_arg_works() {
    // Exercise the argv-spec path (the CLI uses stdin; both must work).
    let root = temp_root("argv");
    let spec_path = root.join("spec.json");
    std::fs::write(
        &spec_path,
        serde_json::json!({ "root": root, "files": ["tests/nope.test.lua"] }).to_string(),
    )
    .expect("write spec file");

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-lua-runner"))
        .arg(&spec_path)
        .output()
        .expect("runner completes");
    let _ = std::fs::remove_dir_all(&root);

    assert!(output.status.success());
    let parsed: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("JSON on stdout");
    let case = &parsed["files"][0]["cases"][0];
    assert_eq!(case["name"], "(file)");
    assert_eq!(case["passed"], false);
    assert!(
        case["message"]
            .as_str()
            .expect("message string")
            .contains("reading"),
    );
}

#[test]
fn garbage_spec_fails_the_runner_itself() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dcs-lua-runner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn dcs-lua-runner");
    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(b"this is not json")
        .expect("write garbage");
    let output = child.wait_with_output().expect("runner completes");

    assert!(!output.status.success(), "a bad spec must not exit 0");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("parsing spec"),
        "stderr names the failure"
    );
}

#[test]
fn project_modules_resolve_through_package_path() {
    let run = run_spec(
        "require",
        &[
            (
                "Scripts/my-mod/main.lua",
                "local M = { name = \"my mod\" }\nenv.info(\"loaded\")\nreturn M\n",
            ),
            (
                "tests/require.test.lua",
                r#"local mod = require("Scripts.my-mod.main")
test("requires resolve against the project root", function()
  expect(mod.name).toBe("my mod")
  expect(dcs.calls[1].fn).toBe("env.info")
end)
test("require caches: same table, single execution", function()
  expect(require("Scripts.my-mod.main")).toBe(mod)
  expect(#dcs.calls).toBe(1)
end)
"#,
            ),
        ],
    );

    for name in [
        "requires resolve against the project root",
        "require caches: same table, single execution",
    ] {
        let result = case(&run, 0, name);
        assert_eq!(result["passed"], true, "{name} failed: {result:?}");
    }
}
