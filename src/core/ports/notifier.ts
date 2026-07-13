// Port: user-facing notifications. The adapter renders VS Code toasts; error
// notifications carry a "Report Issue" affordance. Presentation is the adapter's
// concern — the core passes a message, an optional cause, and optional actions.

export interface NotifierPort {
  /**
   * Show an error. `error` (the caught cause, if any) may be used to enrich a bug
   * report. Extra `actions` are offered; the chosen one is returned.
   */
  error(message: string, error?: unknown, ...actions: string[]): Promise<string | undefined>;
  /** Show an informational message; the chosen action (if any) is returned. */
  info(message: string, ...actions: string[]): Promise<string | undefined>;
}
