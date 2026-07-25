import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireAuthSessionsChanged, resetVscode, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { VsCodeGitHubAuth } from "../../../src/adapters/vscode/auth";

// The single seam between the extension and VS Code's built-in `github` auth
// provider. Two things about it are load-bearing and invisible from the panels:
//
//  - Silence. The marketplace browses anonymously; `getToken(false)` and
//    `currentSession()` run on startup and on every panel open. If either ever
//    asked for `createIfNone`, VS Code would throw a sign-in modal at a user who
//    only wanted to look at a mod list. Only `signIn()` — a button the user
//    pressed — may prompt.
//  - Not throwing. `getSession` rejects when the user dismisses the consent
//    dialog, and can reject when the provider is unavailable at all. Every
//    caller here treats "no session" as a normal state, so a rejection has to
//    come back as `undefined` rather than tearing down whatever panel asked.

/** The narrowed shape of the mocked provider call, so tests can script it. */
type GetSession = (
  providerId: string,
  scopes: string[],
  options: { silent?: boolean; createIfNone?: boolean },
) => Promise<vscode.AuthenticationSession | undefined>;

const getSession = vi.mocked(vscode.authentication.getSession as unknown as GetSession);

/** A session shaped as VS Code's github provider hands it over. */
function githubSession(token: string, label: string): vscode.AuthenticationSession {
  return { id: `session-${label}`, accessToken: token, account: { id: label, label }, scopes: [] };
}

/** The options every recorded `getSession` call was made with. */
function callOptions(): { silent?: boolean; createIfNone?: boolean }[] {
  return getSession.mock.calls.map((c) => c[2]);
}

let auth: VsCodeGitHubAuth;

beforeEach(() => {
  resetVscode();
  getSession.mockReset();
  getSession.mockResolvedValue(undefined);
  auth = new VsCodeGitHubAuth();
});

describe("VsCodeGitHubAuth", () => {
  it("asks the github provider for no scopes at all", async () => {
    // Public reads need none, and an empty scope set is what keeps the consent
    // dialog to "read your profile" instead of a wall of permissions people
    // decline. Requesting a scope here would also invalidate existing sessions.
    getSession.mockResolvedValue(githubSession("tok", "amelia"));
    await auth.getToken(true);
    await auth.getToken(false);
    for (const call of getSession.mock.calls) {
      expect(call[0]).toBe("github");
      expect(call[1]).toEqual([]);
    }
  });

  describe("getToken", () => {
    it("returns the existing token without prompting when createIfNone is false", async () => {
      getSession.mockResolvedValue(githubSession("gho_existing", "amelia"));
      await expect(auth.getToken(false)).resolves.toBe("gho_existing");
      expect(callOptions()).toEqual([{ silent: true }]);
    });

    it("stays silent when there is no session — anonymous browsing must not prompt", async () => {
      await expect(auth.getToken(false)).resolves.toBeUndefined();
      expect(callOptions()).toEqual([{ silent: true }]);
      expect(callOptions().some((o) => o.createIfNone)).toBe(false);
    });

    it("prompts for sign-in when createIfNone is true", async () => {
      getSession.mockResolvedValue(githubSession("gho_fresh", "amelia"));
      await expect(auth.getToken(true)).resolves.toBe("gho_fresh");
      expect(callOptions()).toEqual([{ createIfNone: true }]);
    });

    it("resolves undefined when the user dismisses the consent dialog", async () => {
      // VS Code rejects rather than resolving on cancel; a publish flow that let
      // that escape would surface an unhandled error for a deliberate "no".
      getSession.mockRejectedValue(new Error("User did not consent to login."));
      await expect(auth.getToken(true)).resolves.toBeUndefined();
    });

    it("resolves undefined when the provider itself fails a silent probe", async () => {
      // Seen when the github auth extension is disabled or still activating:
      // every startup read must degrade to signed-out, not to a broken panel.
      getSession.mockRejectedValue(new Error("No authentication provider 'github'."));
      await expect(auth.getToken(false)).resolves.toBeUndefined();
    });
  });

  describe("currentSession", () => {
    it("reduces the vscode session to the token and account label", async () => {
      getSession.mockResolvedValue(githubSession("gho_abc", "amelia"));
      await expect(auth.currentSession()).resolves.toEqual({
        token: "gho_abc",
        accountLabel: "amelia",
      });
      expect(callOptions()).toEqual([{ silent: true }]);
    });

    it("is undefined when signed out, and never prompts to find that out", async () => {
      await expect(auth.currentSession()).resolves.toBeUndefined();
      expect(callOptions().some((o) => o.createIfNone)).toBe(false);
    });

    it("is undefined when the provider rejects", async () => {
      getSession.mockRejectedValue(new Error("provider unavailable"));
      await expect(auth.currentSession()).resolves.toBeUndefined();
    });
  });

  describe("signIn", () => {
    it("prompts and returns the signed-in account", async () => {
      getSession.mockResolvedValue(githubSession("gho_new", "amelia"));
      await expect(auth.signIn()).resolves.toEqual({
        token: "gho_new",
        accountLabel: "amelia",
      });
      expect(callOptions()).toEqual([{ createIfNone: true }]);
    });

    it("returns undefined when the user backs out of the flow", async () => {
      getSession.mockRejectedValue(new Error("User did not consent to login."));
      await expect(auth.signIn()).resolves.toBeUndefined();
    });
  });

  describe("onDidChangeSessions", () => {
    it("notifies when the github session changes", async () => {
      // Signing in from VS Code's own accounts menu has to reach the panels;
      // this event is the only way they learn about it.
      const listener = vi.fn();
      auth.onDidChangeSessions(listener);
      fireAuthSessionsChanged("github");
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("ignores other providers' session changes", async () => {
      // The event is global: a Microsoft or Copilot sign-in would otherwise make
      // every subscribed panel refetch from GitHub for nothing.
      const listener = vi.fn();
      auth.onDidChangeSessions(listener);
      fireAuthSessionsChanged("microsoft");
      expect(listener).not.toHaveBeenCalled();
    });

    it("stops notifying once the subscription is disposed", async () => {
      const listener = vi.fn();
      auth.onDidChangeSessions(listener).dispose();
      fireAuthSessionsChanged("github");
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
