// Editor functions: the IDE's owned line/selection command keymap
// (issue #18). These wire `@codemirror/commands` into an explicit, documented
// keymap so the editor functions are a deliberate IDE contract — not an
// undocumented side effect of `basicSetup`'s `defaultKeymap` (which binds the
// same keys today, but is a library default we don't own). The canonical
// reference is docs/keybindings.md.
//
// Bindings follow the CodeMirror / VS Code convention so muscle memory holds:
//   Mod-/                toggle line comment — uses the language's
//                        commentTokens (Lua's StreamLanguage supplies `--`),
//                        so the right comment marker is chosen per file type.
//   Alt-ArrowUp/Down     move the current line (or selected lines) up / down.
//   Shift-Alt-Up/Down    duplicate the current line (or selection) up / down.
//
// Expand selection is intentionally NOT wired here. The `@codemirror/commands`
// command for it (`selectParentSyntax`) walks the Lezer syntax tree, but Lua is
// highlighted by a StreamLanguage whose tree is token-flat (no syntactic
// nesting), so it lands on the token under the caret and then dead-ends — it
// never grows by scope. A useful expand-selection needs a Lezer Lua grammar (or
// an engine-backed selection); it is tracked separately. See docs/keybindings.md.

import { keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import {
  copyLineDown,
  copyLineUp,
  moveLineDown,
  moveLineUp,
  toggleComment,
} from "@codemirror/commands";

/**
 * The IDE's editor-function keymap. Added at high precedence so these bindings
 * are the authoritative owners of their keys, above `basicSetup`'s defaults —
 * the editor functions stay intact even if the base setup changes.
 */
export const editorCommands: Extension = Prec.high(
  keymap.of([
    { key: "Mod-/", run: toggleComment },
    { key: "Alt-ArrowUp", run: moveLineUp },
    { key: "Alt-ArrowDown", run: moveLineDown },
    { key: "Shift-Alt-ArrowUp", run: copyLineUp },
    { key: "Shift-Alt-ArrowDown", run: copyLineDown },
  ]),
);
