import * as vscode from "vscode";
import type { AuthPort } from "../../core/ports/auth";

// VS Code adapter for `AuthPort`, wrapping the built-in `github` authentication
// provider. Public discovery/reads need no scopes; an empty-scope token still
// lifts the rate limit above anonymous and keeps the consent prompt minimal.

const SCOPES: string[] = [];

/** An existing GitHub session without prompting, or undefined. */
export async function currentSession(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession("github", SCOPES, { silent: true });
  } catch {
    return undefined;
  }
}

/** Prompt for GitHub sign-in (native VS Code flow), or undefined if declined. */
export async function signIn(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession("github", SCOPES, { createIfNone: true });
  } catch {
    return undefined; // user cancelled the consent dialog
  }
}

/** `AuthPort` over VS Code's built-in `github` auth provider. */
export class VsCodeGitHubAuth implements AuthPort {
  async getToken(createIfNone: boolean): Promise<string | undefined> {
    const session = createIfNone ? await signIn() : await currentSession();
    return session?.accessToken;
  }

  onDidChangeSessions(listener: () => void): { dispose(): void } {
    return vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === "github") listener();
    });
  }
}
