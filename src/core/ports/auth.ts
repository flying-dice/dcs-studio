// Port: GitHub authentication. The adapter wraps VS Code's built-in `github`
// auth provider; consumers only need a token, an account label and a change
// signal — never the vscode session object.

/** A resolved GitHub session, reduced to what the panels need. */
export interface AuthSession {
  /** The access token for authenticated GitHub API calls. */
  token: string;
  /** The signed-in account's display label (the GitHub username). */
  accountLabel: string;
}

export interface AuthPort {
  /**
   * The current access token, or undefined. When `createIfNone` is true the
   * adapter may prompt the user to sign in; when false it stays silent.
   */
  getToken(createIfNone: boolean): Promise<string | undefined>;
  /** Subscribe to session changes; call the returned disposer to stop listening. */
  onDidChangeSessions(listener: () => void): { dispose(): void };
  /** The current session without prompting, or undefined when signed out. */
  currentSession(): Promise<AuthSession | undefined>;
  /** Prompt for sign-in (native flow); undefined if the user declines. */
  signIn(): Promise<AuthSession | undefined>;
}
