import * as vscode from "vscode";
import type { AuthPort, AuthSession } from "../../core/ports/auth";

// VS Code adapter for `AuthPort`, wrapping the built-in `github` authentication
// provider. Public discovery/reads need no scopes; an empty-scope token still
// lifts the rate limit above anonymous and keeps the consent prompt minimal.
// This is the ONLY module that touches vscode's auth API — panels reach it
// through the injected AuthPort.

const SCOPES: string[] = [];

/** An existing GitHub session without prompting, or undefined. */
async function silentSession(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession("github", SCOPES, { silent: true });
  } catch {
    return undefined;
  }
}

/** Prompt for GitHub sign-in (native VS Code flow), or undefined if declined. */
async function promptSession(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession("github", SCOPES, { createIfNone: true });
  } catch {
    return undefined; // user cancelled the consent dialog
  }
}

function toAuthSession(s: vscode.AuthenticationSession | undefined): AuthSession | undefined {
  return s ? { token: s.accessToken, accountLabel: s.account.label } : undefined;
}

/** `AuthPort` over VS Code's built-in `github` auth provider. */
export class VsCodeGitHubAuth implements AuthPort {
  async getToken(createIfNone: boolean): Promise<string | undefined> {
    const session = createIfNone ? await promptSession() : await silentSession();
    return session?.accessToken;
  }

  async currentSession(): Promise<AuthSession | undefined> {
    return toAuthSession(await silentSession());
  }

  async signIn(): Promise<AuthSession | undefined> {
    return toAuthSession(await promptSession());
  }

  onDidChangeSessions(listener: () => void): { dispose(): void } {
    return vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === "github") listener();
    });
  }
}
