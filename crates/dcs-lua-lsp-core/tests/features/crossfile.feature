Feature: Cross-file type checking
  Mirrors lua-language-server's `test/crossfile`: a function declared in one
  file is checked at call sites in another, and @class/@alias types resolve
  workspace-wide.

  Scenario: a global function's @param is checked from another file
    Given a Lua file "lib.lua" with:
      """
      --- @param n number
      function add_one(n) end
      """
    And a Lua file "main.lua":
      """
      add_one("not a number")
      """
    When the workspace is type-checked
    Then diagnostic "LUA-T001" is reported

  Scenario: an aliased type resolves to its target
    Given a Lua file "types.lua" with:
      """
      --- @alias Meters number
      """
    And a Lua file "main.lua":
      """
      --- @param d Meters
      local function travel(d) end
      travel("far")
      """
    When the workspace is type-checked
    Then diagnostic "LUA-T001" is reported

  Scenario: a subclass is assignable to its parent
    Given a Lua file "types.lua" with:
      """
      --- @class Animal

      --- @class Dog : Animal
      """
    And a Lua file "main.lua":
      """
      --- @param a Animal
      local function feed(a) end
      --- @type Dog
      local d = make_dog()
      feed(d)
      """
    When the workspace is type-checked
    Then no diagnostics are reported
