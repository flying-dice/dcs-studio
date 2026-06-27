// In-file find / replace: the editor's owned search wiring (issue #73). It wraps
// CodeMirror's maintained search (`@codemirror/search`) — no custom search engine
// (the NFR) — into an explicit, documented contract, the same ownership pattern
// as `editorCommands` (src/lib/editor/commands.ts): `searchKeymap` is bound at
// high precedence so ⌘F / Ctrl+F (and find-next / -previous, select-all-matches)
// are the IDE's deliberate keys, above `basicSetup`'s identical default — they
// survive a base-setup change. The canonical reference is docs/keybindings.md.
//
// `search({ top: true })` docks the find panel at the top (VS Code / Fleet
// convention). `highlightSelectionMatches` is deliberately NOT added here:
// `basicSetup` already includes it, so re-adding it would double-register the
// view plugin (two identical decoration passes). The panel itself owns the
// in-panel gestures — Enter / Shift-Enter step to the next / previous match
// (wrapping), Esc closes and returns focus to the document — and the
// case-sensitive / whole-word / regex toggles, an invalid regex flagged inline.

import { keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";

/**
 * The IDE's in-file find/replace extension: CodeMirror's search panel docked at
 * the top, with `searchKeymap` owned at high precedence so the editor's find is
 * the authoritative owner of ⌘F / Ctrl+F above `basicSetup`'s default binding.
 */
export const searchExtensions: Extension = [
  search({ top: true }),
  Prec.high(keymap.of(searchKeymap)),
];

// Re-exported so the find panel has a single seam: the editor opens it on the
// ⌘F keymap (above) and the application menu / global shortcut reach it through
// the editor command bus (Editor.svelte → app.editFind), both via this command.
export { openSearchPanel };
