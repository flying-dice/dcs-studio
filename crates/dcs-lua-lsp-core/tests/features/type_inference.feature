Feature: Type inference
  Mirrors lua-language-server's `test/type_inference`, DCS Lua 5.1 subset:
  literals, operators, and resolution-backed identifier/return inference.

  Scenario: string literal
    Given a Lua file "m.lua":
      """
      local s = "hello"
      """
    When the workspace is type-checked
    Then the type of local "s" is "string"

  Scenario: arithmetic is a number
    Given a Lua file "m.lua":
      """
      local n = 1 + 2
      """
    When the workspace is type-checked
    Then the type of local "n" is "number"

  Scenario: concatenation is a string
    Given a Lua file "m.lua":
      """
      local s = "a" .. "b"
      """
    When the workspace is type-checked
    Then the type of local "s" is "string"

  Scenario: comparison is a boolean
    Given a Lua file "m.lua":
      """
      local b = 1 < 2
      """
    When the workspace is type-checked
    Then the type of local "b" is "boolean"

  Scenario: a call takes the callee's @return type
    Given a Lua file "m.lua":
      """
      --- @return string
      local function name() end
      local x = name()
      """
    When the workspace is type-checked
    Then the type of local "x" is "string"
