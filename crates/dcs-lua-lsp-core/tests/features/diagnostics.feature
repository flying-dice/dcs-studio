Feature: Argument and operator type lints
  Mirrors lua-language-server's `test/diagnostics` cases, scoped to the DCS Lua
  5.1 dialect. A call argument not assignable to a declared @param type is the
  `param-type-mismatch` lint (deny/error by default); `operator-type-mismatch`
  (an operator on an unfit operand) and `param-usage-mismatch` (an argument that
  conflicts with an un-annotated parameter's body usage) warn, since Lua coerces
  numeric strings and metamethods may overload operators. Lints carry levels —
  `allow`/`warn`/`deny`/`forbid` — set inline (`---@allow`) or in `[lints.lua]`.

  Scenario: number argument to a string param is flagged
    Given a Lua file "m.lua":
      """
      --- @param msg string
      local function log(msg) end
      log(1)
      """
    When the workspace is type-checked
    Then diagnostic "param-type-mismatch" is reported at the argument "1"
    And 1 diagnostic is reported

  Scenario: string argument to a string param is clean
    Given a Lua file "m.lua":
      """
      --- @param msg string
      local function log(msg) end
      log("hi")
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: optional param accepts nil
    Given a Lua file "m.lua":
      """
      --- @param name string?
      local function greet(name) end
      greet(nil)
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: union param accepts any member
    Given a Lua file "m.lua":
      """
      --- @param v string|number
      local function f(v) end
      f(1)
      f("x")
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: boolean argument to a union of string and number is flagged
    Given a Lua file "m.lua":
      """
      --- @param v string|number
      local function f(v) end
      f(true)
      """
    When the workspace is type-checked
    Then diagnostic "param-type-mismatch" is reported at the argument "true"

  Scenario: unannotated param never flags
    Given a Lua file "m.lua":
      """
      local function f(x) end
      f(1)
      f("s")
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: unresolved callee never flags
    Given a Lua file "m.lua":
      """
      undefined_fn(1, 2, 3)
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: an any-typed param suppresses checking
    Given a Lua file "m.lua":
      """
      --- @param v any
      local function f(v) end
      f(1)
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: a generic param never flags
    Given a Lua file "m.lua":
      """
      --- @generic T
      --- @param v T
      local function id(v) end
      id(1)
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: concatenating a table is warned (operator-type-mismatch)
    Given a Lua file "m.lua":
      """
      local x = "a" .. {}
      """
    When the workspace is type-checked
    Then diagnostic "operator-type-mismatch" is reported at the argument "{}"

  Scenario: length of a number is warned (operator-type-mismatch)
    Given a Lua file "m.lua":
      """
      local n = #42
      """
    When the workspace is type-checked
    Then diagnostic "operator-type-mismatch" is reported at the argument "42"

  Scenario: a numeric string literal in arithmetic is clean
    Given a Lua file "m.lua":
      """
      local x = "10" + 5
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: a string argument conflicts with a numerically-used parameter
    Given a Lua file "m.lua":
      """
      local function f(p) return p + 1 end
      f("x")
      """
    When the workspace is type-checked
    Then diagnostic "param-usage-mismatch" is reported
    And 1 diagnostic is reported

  Scenario: a number argument matching parameter usage is clean
    Given a Lua file "m.lua":
      """
      local function f(p) return p + 1 end
      f(5)
      """
    When the workspace is type-checked
    Then no diagnostics are reported

  Scenario: an inline ---@allow silences a lint
    Given a Lua file "m.lua":
      """
      ---@allow operator-type-mismatch
      local x = "a" .. {}
      """
    When diagnostics are collected
    Then no diagnostics are reported

  Scenario: ---@allow governs only the named lint
    Given a Lua file "m.lua":
      """
      ---@allow param-usage-mismatch
      local x = #42
      """
    When diagnostics are collected
    Then diagnostic "operator-type-mismatch" is reported

  Scenario: ---@expect reports when its lint never fires
    Given a Lua file "m.lua":
      """
      ---@expect operator-type-mismatch
      local x = 1
      """
    When diagnostics are collected
    Then diagnostic "unfulfilled-lint-expectation" is reported
