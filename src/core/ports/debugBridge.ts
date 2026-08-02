import type { BridgeStatus, DualBridgeStatus } from "../domain/bridgeProtocol";
import type {
  DebugEnv,
  DebugState,
  DebugValue,
  LuaEnv,
  ReplVariable,
} from "../domain/debugProtocol";

// Port: what a debug session needs from a bridge, and from the pair of them.
//
// The debug adapter used to name `BridgeClient` and `BridgeClients` directly —
// a feature reaching into another feature (#61). Both imports were type-only,
// so the coupling bought nothing at runtime and cost the ability to drive a
// session against anything but the real WebSocket client.
//
// Stated member by member rather than `Pick<BridgeClient, …>`: a `Pick` would
// still name the concrete class and re-create the crossing, and it would let
// the surface silently widen. The concrete client satisfies this structurally;
// `BridgeClient implements DebugBridgePort` documents the intent and fails the
// build if either side drifts.

/** A subscription that stops when disposed — `vscode.Disposable`'s shape. */
export interface BridgeSubscription {
  dispose(): void;
}

/** One bridge, as a debug session drives it. */
export interface DebugBridgePort {
  /** Connection state and last-seen sim time, updated by the ping loop. */
  readonly current: BridgeStatus;

  /** Console output since `after`, with the sequence to ask from next time. */
  consoleRead(after: number): Promise<{ lines: { seq: number; text: string }[]; latest: number }>;

  /** Evaluate an expression in the sim outside a paused frame. */
  replEval(env: LuaEnv, code: string): Promise<{ ok: boolean; result?: unknown; err?: string }>;

  /**
   * Start the session in the sim. Resolution is a fast-path end for short
   * scripts; a long session outlives the response window, so `debugState`
   * polling is the truth. The default timeout is the client's business, so it
   * is optional here.
   */
  debugRun(
    env: DebugEnv,
    source: string,
    code: string,
    pauseOnError: boolean,
    timeoutMs?: number,
  ): Promise<{ ran?: boolean; error?: string | null }>;

  /** The paused snapshot: frames, scopes and why it stopped. */
  debugState(): Promise<DebugState>;
  /** Resume — `mode` selects continue/step-over/step-in/step-out. */
  debugContinue(mode: string): Promise<unknown>;
  /** Ask the engine to stop at the next line it runs. */
  debugPause(): Promise<unknown>;
  /** End the session in the sim, releasing any held pause. */
  debugStop(): Promise<unknown>;
  /** Children of a structured value the snapshot referenced. */
  debugExpand(ref: number): Promise<{ variables: ReplVariable[] }>;
  /** Evaluate in the context of a paused frame (watch, hover, REPL). */
  debugEval(frame: number, expr: string): Promise<DebugValue>;
  /** Replace the breakpoints for one source; returns how many were accepted. */
  debugSetBreakpoints(
    source: string,
    breakpoints: { line: number; condition?: string }[],
  ): Promise<{ count: number }>;
  /** Drop every breakpoint and condition (session start/end hygiene). */
  debugClearBreakpoints(): Promise<unknown>;
}

/**
 * The pair, as the debug adapter and the sidebar drive it.
 *
 * `forEnv` is the whole reason the adapter takes the pair rather than one
 * bridge: a session's env decides which of the two serves it, and that routing
 * rule is `bridgeForEnv` in the domain.
 */
export interface BridgeRouterPort {
  /** The bridge serving `env` — mission sessions to the mission bridge, else GUI. */
  forEnv(env: string): DebugBridgePort;
  /** Both bridges' current status, for anything showing the pair at once. */
  readonly current: DualBridgeStatus;
  /** Re-notified whenever either bridge's status changes. */
  onStatus(fn: (s: DualBridgeStatus) => void): BridgeSubscription;
}
