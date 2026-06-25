// The Lua provider: the standalone `lua-analyzer` binary hosted by the backend,
// spoken to over IPC (decisions/005) — hosted exactly like rust-analyzer (it
// indexes the project from the rootUri). The one `LanguageProvider` the app
// uses for `.lua`. The connection lifecycle and queries live in the shared
// HostedLspProvider base; this class adds only the lua-specific bits: the
// root-keyed connect seam and inlay hints.

import { invoke } from "@tauri-apps/api/core";
import { LspClient } from "./lsp-client";
import { HostedLspProvider } from "./hosted-lsp-provider";
import { lineStarts } from "./offsets";
import { lineStart, pathToUri } from "./lsp-wire";
import type { InlayHint } from "./provider";

/** Production connection: ask the backend for the lua-analyzer binary, host it
 * as a standalone process — exactly how rust-analyzer is hosted.
 *
 * lua-analyzer is root-bound (it indexes the project from `rootUri`): pass
 * `root` as the re-attach key so the backend re-attaches only to a server
 * rooted here (skipping the handshake after a reload), while a different root
 * evicts the stale server and spawns fresh, re-initializing against the new
 * project (issue #31 / MR !20). The backend assigns the physical id and keys
 * the IPC channel; the stable logical id is just `"dcs-lua"`. */
async function connectViaHost(
  root: string,
): Promise<{ client: LspClient; isNew: boolean }> {
  const program = await invoke<string>("lua_analyzer_path");
  return LspClient.start("dcs-lua", program, [], root);
}

export class LuaAnalyzerProvider extends HostedLspProvider {
  // The LOGICAL provider id is shared via dcs-lua.ts: the app sees one "dcs-lua"
  // Lua provider whichever transport backs it. The BINARY is lua-analyzer; the
  // backend assigns a physical id per spawn and re-attaches by this logical id
  // keyed on the project root.
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];
  protected readonly languageId = "lua";

  /** `connect` is injectable so `/lab/lsp` drives this exact class. */
  constructor(
    connect: (
      root: string,
    ) => Promise<{ client: LspClient; isNew: boolean }> = connectViaHost,
  ) {
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
