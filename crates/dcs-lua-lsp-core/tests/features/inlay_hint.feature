Feature: Inferred-type inlay hints
  Mirrors lua-language-server's `test/inlay_hint` variable-type hints: an
  unannotated local gets a `: <type>` ghost-text label; an annotated or
  un-inferable local gets none.

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
