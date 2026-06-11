Feature: Argument type checking (LUA-T001)
  Mirrors lua-language-server's `test/diagnostics` param-type cases, scoped to
  the DCS Lua 5.1 dialect. A call argument whose inferred type is not
  assignable to the declared @param type is reported; everything the
  conservative rule cannot prove stays silent.

  Scenario: number argument to a string param is flagged
    Given a Lua file "m.lua":
      """
      --- @param msg string
      local function log(msg) end
      log(1)
      """
    When the workspace is type-checked
    Then diagnostic "LUA-T001" is reported at the argument "1"
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
    Then diagnostic "LUA-T001" is reported at the argument "true"

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
