import { spawn, spawnSync } from "child_process";
import { ghArgs } from "../../core/domain/cliArgs";
import type { GhFacts } from "../../core/domain/publishChecks";
import type {
  GhPort,
  GhReleaseCreateOptions,
  GhReleaseEditOptions,
  GhRepoCreateOptions,
  GhRepoCreateResult,
} from "../../core/ports/gh";

// Node adapter for `GhPort`, driving the GitHub CLI. Owns every gh process
// spawn used by the publish flow; the orchestration policy lives in
// core/app/publishService.ts. The sync probes (ghLoginSync/ghFactsSync) exist
// for the synchronous preflight/panel paths.

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr || e.message }));
    p.on("exit", (c) => resolve({ code: c ?? -1, stdout, stderr }));
  });
}

async function must(cmd: string, args: string[], label: string): Promise<string> {
  const r = await run(cmd, args);
  if (r.code !== 0)
    throw new Error(`${label}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** The signed-in GitHub login, or null (sync, for the publish panel). */
export function ghLoginSync(): string | null {
  const r = spawnSync("gh", ghArgs.apiUser(), {
    windowsHide: true,
    encoding: "utf8",
  });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

/** gh CLI presence + auth facts (sync, for the preflight panel). */
export function ghFactsSync(): GhFacts {
  let present = false;
  let authed = false;
  try {
    present = !spawnSync("gh", ghArgs.version(), { windowsHide: true }).error;
    if (present) {
      authed = spawnSync("gh", ghArgs.authStatus(), { windowsHide: true }).status === 0;
    }
  } catch {
    /* not installed */
  }
  return { present, authed };
}

/** `GhPort` over the GitHub CLI. */
export class GhCli implements GhPort {
  async isInstalled(): Promise<boolean> {
    return ghFactsSync().present;
  }

  async isAuthed(): Promise<boolean> {
    return ghFactsSync().authed;
  }

  async login(): Promise<string | null> {
    return ghLoginSync();
  }

  async repoCreate(opts: GhRepoCreateOptions): Promise<GhRepoCreateResult> {
    const create = await run("gh", ghArgs.repoCreate(opts));
    if (create.code === 0) return { created: true, alreadyExists: false };
    if (/already exists|Name already exists/i.test(create.stderr)) {
      return { created: false, alreadyExists: true };
    }
    throw new Error(`gh repo create: ${create.stderr.trim() || create.stdout.trim()}`);
  }

  // Best-effort by design: a topic-tagging failure never blocks a publish. The
  // outcome is still returned, because a mod that failed to get the discovery
  // topic is invisible in the Marketplace and the user has to be told.
  async repoTopicAdd(repo: string, topic: string): Promise<boolean> {
    return (await run("gh", ghArgs.repoTopicAdd(repo, topic))).code === 0;
  }

  async releaseView(repo: string, tag: string): Promise<boolean> {
    const r = await run("gh", ghArgs.releaseView(repo, tag));
    return r.code === 0;
  }

  // Idempotent: deleting a release that doesn't exist is a silent no-op. Used
  // to roll back a release this run half-created, never to clear the way for
  // one — an existing release is replaced through upload/edit instead.
  async releaseDelete(repo: string, tag: string): Promise<void> {
    await run("gh", ghArgs.releaseDelete(repo, tag));
  }

  async releaseCreate(opts: GhReleaseCreateOptions): Promise<void> {
    await must("gh", ghArgs.releaseCreate(opts), "gh release create");
  }

  async releaseUpload(repo: string, tag: string, assets: string[]): Promise<void> {
    await must("gh", ghArgs.releaseUpload(repo, tag, assets), "gh release upload");
  }

  async releaseEdit(opts: GhReleaseEditOptions): Promise<void> {
    await must("gh", ghArgs.releaseEdit(opts), "gh release edit");
  }

  // A release that cannot be read back reports no assets: the caller only uses
  // the list to prune leftovers, and pruning nothing is the safe answer.
  async releaseAssetNames(repo: string, tag: string): Promise<string[]> {
    const r = await run("gh", ghArgs.releaseAssetNames(repo, tag));
    if (r.code !== 0) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // Best-effort: a leftover asset that refuses to delete is untidy, not a
  // reason to fail a release whose payload is already uploaded.
  async releaseAssetDelete(repo: string, tag: string, name: string): Promise<boolean> {
    return (await run("gh", ghArgs.releaseAssetDelete(repo, tag, name))).code === 0;
  }
}
