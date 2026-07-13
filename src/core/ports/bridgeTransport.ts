// Port: the live transport to the in-DCS bridge. The adapter is a minimal
// client-side WebSocket over raw TCP; the core only sees connect/send/close plus
// lifecycle callbacks — no framing/socket details.

export interface BridgeEndpoint {
  host: string;
  port: number;
  path: string;
}

export interface BridgeHandlers {
  onOpen?(): void;
  onMessage?(text: string): void;
  onClose?(code: number, reason: string): void;
  onError?(err: Error): void;
}

export interface BridgeConnection {
  /** Send a text message (dropped if the connection is not open). */
  send(text: string): void;
  /** Close the connection. */
  close(): void;
}

export interface BridgeTransportPort {
  /** Open a connection to `endpoint`, delivering events to `handlers`. */
  connect(endpoint: BridgeEndpoint, handlers: BridgeHandlers): BridgeConnection;
}
