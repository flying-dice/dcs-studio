Feature: Inferred-type inlay hints
  Mirrors lua-language-server's `test/inlay_hint`: an unannotated local gets a
  `: <type>` ghost-text label (an annotated or un-inferable one gets none), and
  a function signature gains hints for each parameter whose type its body
  implies and for the inferred return type.

  Scenario: literal locals get type hints
    Given a Lua file "m.lua":
      """
      local s = "x"
      local n = 1
      """
    When inlay hints for the file are requested
    Then an inlay hint ": string" follows "s"
    And an inlay hint ": number" follows "n"

  Scenario: an explicitly typed local gets no hint
    Given a Lua file "m.lua":
      """
      --- @type number
      local n = some_call()
      """
    When inlay hints for the file are requested
    Then no inlay hints are returned

  Scenario: an un-inferable local gets no hint
    Given a Lua file "m.lua":
      """
      local x = undefined_call()
      """
    When inlay hints for the file are requested
    Then no inlay hints are returned

  Scenario: a parameter and return type are inferred from body usage
    Given a Lua file "m.lua":
      """
      local function f(p)
        return p:upper()
      end
      """
    When inlay hints for the file are requested
    Then an inlay hint ": string" follows "(p"
    And an inlay hint ": string" follows "(p)"

  Scenario: a `@param` annotation wins over usage
    Given a Lua file "m.lua":
      """
      --- @param p number
      local function f(p)
        return p
      end
      """
    When inlay hints for the file are requested
    Then an inlay hint ": number" follows "(p"

  Scenario: a parameter used two incompatible ways gets no parameter type hint
    Given a Lua file "m.lua":
      """
      local function f(p)
        print(p .. "x")
        print(p + 1)
      end
      """
    When inlay hints for the file are requested
    Then an inlay hint ": void" follows "(p)"

  Scenario: a void function gets a `: void` return hint
    Given a Lua file "m.lua":
      """
      local function log(msg)
        print(msg)
      end
      """
    When inlay hints for the file are requested
    Then an inlay hint ": void" follows "(msg)"

  Scenario: global field assignments show the inferred type
    Given a Lua file "m.lua":
      """
      local M = {}
      M.name    = "my-mod"
      M.version = 1
      """
    When inlay hints for the file are requested
    Then an inlay hint ": string" follows "M.name"
    And an inlay hint ": number" follows "M.version"
