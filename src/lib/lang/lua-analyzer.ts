// The Lua provider: the standalone `lua-analyzer` binary hosted by the backend,
// spoken to over IPC (decisions/005) — hosted exactly like rust-analyzer (it
// indexes the project from the rootUri). The one `LanguageProvider` the app
// uses for `.lua`. The connection lifecycle and queries live in the shared
// HostedLspProvider base; this class adds only the lua-specific bits: the
// (salted) connect seam and inlay hints.

import { invoke } from "@tauri-apps/api/core";
import { LspClient } from "./lsp-client";
import { HostedLspProvider } from "./hosted-lsp-provider";
import { lineStarts } from "./offsets";
import { lineStart, pathToUri } from "./lsp-wire";
import type { InlayHint } from "./provider";

// A fresh host id per spawn — same reasoning as rust-analyzer.ts: a project
// switch stops the old server and reconnects, but the backend host map lingers
// until the old process is reaped, so a shared id would hit lsp_start's
// idempotent guard and the new client would talk to a dying server. The logical
// provider id stays "dcs-lua" (below); only the host connection id is sequenced.
//
// The sequence is also salted with a per-page-load token: a full page
// navigation (which the e2e-lang suite does between specs against the one
// running app) resets module state to seq 0, so without the salt every load's
// first connection would reuse id `dcs-lua:1` — and lsp_start, idempotent on
// id, would hand back the PREVIOUS load's now-stale server (its old file still
// open), starving every positional query. The salt makes each page load's ids
// disjoint, so a reload always gets a fresh server. Tauri event names allow
// alphanumerics and `-/:_`, so the token stays within that set.
const HOST_CONNECTION_SALT = Math.random().toString(36).slice(2, 8);
let hostConnectionSeq = 0;

/** Production connection: ask the backend for the lua-analyzer binary, host it
 * as a standalone process — exactly how rust-analyzer is hosted.
 *
 * The connection id is `:`-separated, NOT `#`: it becomes a Tauri event name
 * (`lsp://message/<id>`), and Tauri only permits alphanumerics + `-/:_` — a
 * `#` makes `listen()` throw and the server never connects. */
async function connectViaHost(): Promise<LspClient> {
  const program = await invoke<string>("lua_analyzer_path");
  hostConnectionSeq += 1;
  return LspClient.start(
    `dcs-lua:${HOST_CONNECTION_SALT}-${hostConnectionSeq}`,
    program,
    [],
  );
}

export class LuaAnalyzerProvider extends HostedLspProvider {
  // The LOGICAL provider id is shared via dcs-lua.ts: the app sees one "dcs-lua"
  // Lua provider whichever transport backs it. The BINARY is lua-analyzer; only
  // the host connection id (above) is sequenced.
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];
  protected readonly languageId = "lua";

  /** `connect` is injectable so `/lab/lsp` drives this exact class. */
  constructor(connect: () => Promise<LspClient> = connectViaHost) {
    super(connect);
  }

  // lua-analyzer walks the project itself from the rootUri (like rust-analyzer),
  // so the base's mount hands it the root and its initialize walk finds every
  // Lua source — no special capabilities to declare.
  protected initializeCapabilities(): Record<string, unknown> {
    return {};
  }

  protected renameUnavailableMessage(): string {
    return "language engine unavailable";
  }

  // lua-analyzer advertises `inlayHintProvider` and answers from the same engine
  // inlay-hint query. Defensive `[]` on any error so a server that lacks it can
  // never abort the editor's lint pass.
  async inlayHints(path: string): Promise<InlayHint[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    const lastLine = Math.max(0, starts.length - 1);
    let response:
      | { position: { line: number; character: number }; label: unknown }[]
      | null;
    try {
      response = (await this.client.request("textDocument/inlayHint", {
        textDocument: { uri: pathToUri(path) },
        range: {
          start: { line: 0, character: 0 },
          end: { line: lastLine, character: 0 },
        },
      })) as
        | { position: { line: number; character: number }; label: unknown }[]
        | null;
    } catch {
      return []; // server lacks inlay hints — surface none, never throw
    }
    return (response ?? []).map((hint) => ({
      offset: lineStart(starts, hint.position.line) + hint.position.character,
      label: typeof hint.label === "string" ? hint.label : String(hint.label),
      kind: "Type",
    }));
  }
}
