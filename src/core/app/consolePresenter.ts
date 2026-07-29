import { exportFileBase } from "../domain/bridgeConsole";
import type { DualBridgeStatus } from "../domain/bridgeProtocol";
import type {
  LuaEnv,
  ReplInspectResult,
  ReplSignatureResult,
  ReplVariable,
} from "../domain/debugProtocol";
import { errorText } from "../domain/errorText";

// The Lua console's decision logic, lifted out of the VS Code panel.
//
// The console is a REPL against the live sim over two independent bridges, and
// nearly everything it does is a routing or bookkeeping decision: which bridge
// serves the message's env, which requests are well-formed enough to send at
// all, how a rejected RPC becomes an answer the webview can stop waiting on,
// and — the one piece of real state — where each bridge's output ring has been
// read up to and when that cursor has to go back to zero. All of it used to be
// welded to a webview shell, so none of it could be asserted without an
// extension host.
//
// This module owns that behaviour and knows nothing about VS Code. Outgoing
// webview messages go through `post`; the one thing only the editor can do is
// described as a `ConsoleEffect` for the adapter to perform. The exception is
// `saveExport`: whether anything was written is an answer the rules branch on
// (the webview's export request has to be told "saved" or "cancelled"), so it
// is a dependency — asked and awaited — not a fire-and-forget effect.

/** Something only the editor can do, described rather than done. */
export type ConsoleEffect = { kind: "launchBridge" };

/** The message shapes the console webview sends the host. */
export interface ConsoleInbound {
  type: string;
  env?: LuaEnv;
  envs?: LuaEnv[];
  code?: string;
  expr?: string;
  ref?: number;
  id?: number;
  nodeId?: number;
  reqId?: number;
  label?: string;
}

/** A sim-written export file, and the name to offer for the user's copy. */
export interface ConsoleExportSave {
  /** Where the sim serialized the table, inside its own write dir. */
  path: string;
  /** File base name (no extension) to propose in the save dialog. */
  baseName: string;
  /** Size of the export, which decides whether it is opened after saving. */
  bytes: number;
}

/**
 * One bridge, as the console drives it.
 *
 * Deliberately narrower than `DebugBridgePort`: the console needs the whole
 * `repl_*` family that a debug session never touches, and none of the `debug_*`
 * family. Stated member by member so the surface cannot silently widen — the
 * concrete `BridgeClient` satisfies it structurally.
 */
export interface ConsoleBridge {
  /** Connection state; the tail loop branches on it every tick. */
  readonly current: { readonly connected: boolean };
  /** Console lines printed since `after`, with the cursor to ask from next. */
  consoleRead(after: number): Promise<{ lines: { seq: number; text: string }[]; latest: number }>;
  replEval(env: LuaEnv, code: string): Promise<{ ok: boolean; result?: unknown; err?: string }>;
  replInspect(env: LuaEnv, expr: string): Promise<ReplInspectResult>;
  replExpand(env: LuaEnv, ref: number): Promise<{ variables?: ReplVariable[] }>;
  replSignature(env: LuaEnv, ref: number): Promise<ReplSignatureResult>;
  replClear(env: LuaEnv): Promise<unknown>;
  replExport(
    env: LuaEnv,
    spec: { ref?: number; expr?: string },
  ): Promise<{ path: string; bytes: number }>;
}

/** The pair of bridges, as the console drives them. */
export interface ConsoleBridges {
  /** The bridge serving `env` — mission calls to the mission bridge, else GUI. */
  forEnv(env: LuaEnv): ConsoleBridge;
  /** Both bridges' current status, for the webview's status line. */
  readonly current: DualBridgeStatus;
}

export interface ConsolePresenterDeps {
  bridges: ConsoleBridges;
  /**
   * Every bridge with an output ring to tail. Each bridge has its OWN ring, so
   * both are read or half the sim's `print` output never appears. Passed as a
   * list rather than derived from `bridges`, because "which bridges exist" is
   * the composition root's knowledge, not a routing rule.
   */
  tailed: readonly ConsoleBridge[];
  /** The explorer's `**` sweep budget, read fresh so a settings change lands live. */
  wildcardDepth: () => number;
  /** Deliver a message to the webview. */
  post: (msg: unknown) => void;
  /** Perform an editor-side effect. */
  effect: (effect: ConsoleEffect) => void;
  /**
   * Put the sim's export file where the user chooses, and answer whether
   * anything was written — a cancelled save dialog is a normal outcome the
   * webview's request/response protocol has to tell apart from a failure. The
   * host owns the sim-side temp file's lifetime, including tidying it up.
   */
  saveExport: (request: ConsoleExportSave) => Promise<boolean>;
}

/** Where a bridge's output ring has been read up to, and whether it was
 * connected on the previous tick. */
interface ConsoleTail {
  lastSeq: number;
  wasConnected: boolean;
}

export class ConsolePresenter {
  /** Per-bridge tail state. A reconnect means the server (and its ring)
   * restarted — reset the cursor so the fresh ring is read from the start. */
  private readonly tails = new Map<ConsoleBridge, ConsoleTail>();

  constructor(private readonly deps: ConsolePresenterDeps) {
    for (const bridge of deps.tailed) this.tails.set(bridge, { lastSeq: 0, wasConnected: false });
  }

  async handle(msg: ConsoleInbound): Promise<void> {
    const env: LuaEnv = msg.env ?? "gui";
    const client = this.deps.bridges.forEnv(env);
    switch (msg.type) {
      case "ready":
        // The webview finished booting — (re)push the current status and the
        // explorer's sweep-depth config so it renders from a known state.
        this.pushStatus(this.deps.bridges.current);
        this.pushConfig();
        break;
      case "eval": {
        if (typeof msg.code !== "string") return;
        try {
          const r = await client.replEval(env, msg.code);
          if (r.ok)
            this.deps.post({ type: "result", value: r.result === undefined ? null : r.result });
          else this.deps.post({ type: "error", message: r.err || "error" });
        } catch (e) {
          this.deps.post({ type: "error", message: errorText(e) });
        }
        break;
      }
      case "inspect": {
        if (typeof msg.expr !== "string") return;
        try {
          const r = await client.replInspect(env, msg.expr);
          // `luaType` (not `type`) carries the value's Lua type — the envelope's
          // own `type` field is "inspectResult" and must not be shadowed.
          this.deps.post({
            type: "inspectResult",
            id: msg.id,
            env,
            expr: msg.expr,
            ok: r.ok,
            err: r.err,
            luaType: r.type,
            value: r.value,
            ref: r.ref,
          });
        } catch (e) {
          this.deps.post({
            type: "inspectResult",
            id: msg.id,
            env,
            expr: msg.expr,
            ok: false,
            err: errorText(e),
          });
        }
        break;
      }
      case "expand": {
        if (typeof msg.ref !== "number") return;
        try {
          const r = await client.replExpand(env, msg.ref);
          this.deps.post({
            type: "expandResult",
            nodeId: msg.nodeId,
            ok: true,
            variables: r.variables ?? [],
          });
        } catch (e) {
          this.deps.post({
            type: "expandResult",
            nodeId: msg.nodeId,
            ok: false,
            err: errorText(e),
          });
        }
        break;
      }
      case "signature": {
        if (typeof msg.ref !== "number") return;
        try {
          const r = await client.replSignature(env, msg.ref);
          this.deps.post({
            type: "signatureResult",
            reqId: msg.reqId,
            ok: r.ok,
            params: r.params,
            native: r.native,
            err: r.err,
          });
        } catch (e) {
          this.deps.post({
            type: "signatureResult",
            reqId: msg.reqId,
            ok: false,
            err: errorText(e),
          });
        }
        break;
      }
      case "clearExplorer": {
        // Release sim-side refs in every env the tree touched (routed to the
        // env's own bridge); an env that is gone (mission ended) has nothing
        // to release — ignore its error.
        for (const e of msg.envs ?? []) {
          try {
            await this.deps.bridges.forEnv(e).replClear(e);
          } catch {
            /* state gone; nothing held */
          }
        }
        break;
      }
      case "export": {
        await this.export(env, client, msg);
        break;
      }
      case "launch":
        // The offline status line's inline CTA — funnel into the same
        // dcs.bridge.launch command as the Command Palette and the status
        // bar dispatcher (single implementation, per ARCHITECTURE.md).
        this.deps.effect({ kind: "launchBridge" });
        break;
    }
  }

  /** Push the dual bridge status to the webview's status line. */
  pushStatus(s: DualBridgeStatus): void {
    this.deps.post({ type: "status", status: s });
  }

  /** Push the explorer's sweep depth budget (the `**` wildcard cost). */
  pushConfig(): void {
    this.deps.post({ type: "explorerConfig", wildcardDepth: this.deps.wildcardDepth() });
  }

  /** One tick of the output tail. Driven off the tail map itself, so every
   * bridge with tail state is polled and none can be polled without it. */
  async poll(): Promise<void> {
    await Promise.all([...this.tails].map(([client, tail]) => this.pollOne(client, tail)));
  }

  /** Full-table JSON export: the sim serializes to a temp file in its write
   * dir; the host copies that wherever the user picks and says whether it
   * landed, so a cancelled dialog answers the request rather than hanging it. */
  private async export(env: LuaEnv, client: ConsoleBridge, msg: ConsoleInbound): Promise<void> {
    try {
      const { path, bytes } = await client.replExport(env, { ref: msg.ref, expr: msg.expr });
      const saved = await this.deps.saveExport({
        path,
        baseName: exportFileBase(msg.label),
        bytes,
      });
      this.deps.post({ type: "exportDone", reqId: msg.reqId, saved });
    } catch (e) {
      this.deps.post({
        type: "exportDone",
        reqId: msg.reqId,
        saved: false,
        error: errorText(e),
      });
    }
  }

  private async pollOne(client: ConsoleBridge, tail: ConsoleTail): Promise<void> {
    const connected = client.current.connected;
    if (!connected) {
      tail.wasConnected = false;
      return;
    }
    if (!tail.wasConnected) {
      // Fresh connection = the server restarted with a fresh ring (both
      // servers outlive missions and only restart with DCS) — read it from 0.
      tail.wasConnected = true;
      tail.lastSeq = 0;
    }
    try {
      const { lines, latest } = await client.consoleRead(tail.lastSeq);
      if (lines.length) {
        tail.lastSeq = latest;
        this.deps.post({ type: "print", lines });
      } else if (latest > tail.lastSeq) {
        tail.lastSeq = latest;
      }
    } catch {
      /* transient; next tick retries */
    }
  }
}
