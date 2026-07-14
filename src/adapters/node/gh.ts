import { spawn, spawnSync } from "child_process";
import type { GhFacts } from "../../core/domain/publishChecks";
import type {
  GhPort,
  GhReleaseCreateOptions,
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
  const r = spawnSync("gh", ["api", "user", "-q", ".login"], {
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
    present = !spawnSync("gh", ["--version"], { windowsHide: true }).error;
    if (present) {
      authed = spawnSync("gh", ["auth", "status"], { windowsHide: true }).status === 0;
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
    const args = [
      "repo",
      "create",
      opts.name,
      `--${opts.visibility ?? "public"}`,
      "--source",
      opts.source,
    ];
    if (opts.remote) args.push("--remote", opts.remote);
    if (opts.push !== false) args.push("--push");
    args.push("-d", opts.description ?? "");
    const create = await run("gh", args);
    if (create.code === 0) return { created: true, alreadyExists: false };
    if (/already exists|Name already exists/i.test(create.stderr)) {
      return { created: false, alreadyExists: true };
    }
    throw new Error(`gh repo create: ${create.stderr.trim() || create.stdout.trim()}`);
  }

  // Best-effort by design: the original flow ignored a topic-tagging failure —
  // discovery topics are a nicety, not a publish blocker.
  async repoTopicAdd(repo: string, topic: string): Promise<void> {
    await run("gh", ["repo", "edit", repo, "--add-topic", topic]);
  }

  async releaseView(repo: string, tag: string): Promise<boolean> {
    const r = await run("gh", ["release", "view", tag, "-R", repo]);
    return r.code === 0;
  }

  // Idempotent: deleting a release that doesn't exist is a silent no-op.
  async releaseDelete(repo: string, tag: string): Promise<void> {
    await run("gh", ["release", "delete", tag, "-R", repo, "--yes", "--cleanup-tag"]);
  }

  async releaseCreate(opts: GhReleaseCreateOptions): Promise<void> {
    await must(
      "gh",
      [
        "release",
        "create",
        opts.tag,
        ...opts.assets,
        "-R",
        opts.repo,
        "--title",
        opts.title,
        "--notes",
        opts.notes,
      ],
      "gh release create",
    );
  }
}
