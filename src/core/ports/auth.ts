// Port: GitHub authentication. The adapter wraps VS Code's built-in `github`
// auth provider; the core only needs a token and a change signal.

export interface AuthPort {
  /**
   * The current access token, or undefined. When `createIfNone` is true the
   * adapter may prompt the user to sign in; when false it stays silent.
   */
  getToken(createIfNone: boolean): Promise<string | undefined>;
  /** Subscribe to session changes; call the returned disposer to stop listening. */
  onDidChangeSessions(listener: () => void): { dispose(): void };
}
