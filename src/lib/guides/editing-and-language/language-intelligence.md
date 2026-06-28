# Language intelligence

DCS Studio brings IDE-grade language support to your project through hosted language servers: the built-in **lua-analyzer** for Lua, and **rust-analyzer** for Rust. They provide live diagnostics, hover information, code completion, code folding, and the navigation and refactoring actions covered in **Refactoring**. Language intelligence is always an enhancement — if an engine is missing or fails, the rest of the IDE keeps working.

## Diagnostics (problems)

As you type, the engine reports findings — parse errors, type problems, and lint warnings — in two places:

- **Inline** in the editor, as coloured squiggles under the offending span.
- In the **Problems panel**, grouped by file. Each entry shows a severity icon, the message, the `line:column`, and a diagnostic **code** (for example `LUA-E…` for parse errors, or codes like `param-type-mismatch`, `unresolved-require`, and `require-shadowing`). When a code has documentation, the code is a link that opens in your browser.

Other behaviour worth knowing:

- **Click any Problems entry** to open its file and land the caret on the finding.
- **Filter** by severity using the error / warning / info toggles at the top of the panel; each shows a live count, and a hint tells you when findings are hidden by a filter.
- The **status bar** shows live error and warning chips; click either to open the Problems panel. Zero counts are shown subdued rather than hidden.
- For Lua, findings cover the **whole workspace** from the moment a project opens — even files you haven't opened yet — because the engine indexes the project on start-up.
- Findings that arrive late (rust-analyzer's first index and `cargo check` can lag a few seconds) paint into the editor on arrival, without you needing to type again.

## Hover

Hover the pointer over a symbol to see a Markdown card:

- For **Lua**, the card shows a signature line (for example `local greet: string`), the `---` documentation comment above the declaration, and a shallowly inferred type where one applies.
- For **Rust**, the card shows rust-analyzer's hover content.

Links inside a hover card open in your browser rather than navigating the editor away.

## Completion

Suggestions appear at the caret as you type, and typing `.` triggers member completion. The suggestion list is exactly what the engine offers (no generic word-scraping), so it stays accurate to the code. For **Lua**, each suggestion carries a kind (function, field, or variable), a signature detail, and documentation; function members insert a snippet with placeholder parameters you can tab through.

## Inferred-type inlay hints (Lua)

For **Lua**, the editor draws dimmed `: <type>` hints as ghost text where a type is inferred but not written — after unannotated local bindings, after function parameters, and after a parameter list for the inferred return type. Rust files do not show these inlay hints in DCS Studio.

## Code folding

The engine reports foldable regions — blocks, function bodies, and long comments — which you can collapse and expand from the editor's fold gutter.

## What each language gets

- **Lua (lua-analyzer)** — always available; no setup required. Provides diagnostics, hover, completion, folding, inferred-type inlay hints, the Structure outline, and Go to Definition / Find Usages / Rename. It indexes your project itself, including dependencies vendored under `.lua-cargo/deps`.
- **Rust (rust-analyzer)** — available when the project has a `Cargo.toml` **and** rust-analyzer is installed on your system. Provides diagnostics, hover, completion, folding, the Structure outline, and Go to Definition / Find Usages / Rename. It does **not** provide inferred-type inlay hints in DCS Studio. If there's no Cargo project the provider stays quietly idle; if the binary is missing it is disabled — neither case affects the rest of the IDE.

## When an engine is unavailable

Language intelligence never gates the IDE:

- The **status bar** shows a coloured status dot per provider — running, starting, disabled, or crashed — with a tooltip explaining why.
- The **Problems panel** surfaces a notice above file findings when a provider is disabled (with a copyable install command) or has crashed (advising you to restart).
- While rust-analyzer is indexing or running `cargo check`, its status-bar chip pulses and its tooltip shows the current task.

## Tips

- The diagnostic codes in the Problems panel are stable identifiers; click one (when it is underlined) to read its documentation in your browser.
- For navigation and renaming built on this same engine, see **Refactoring**; for the file outline it powers, see **Structure & outline**.
