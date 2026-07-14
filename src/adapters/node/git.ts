import { spawn, spawnSync } from "child_process";
import type { GitPort } from "../../core/ports/git";

// Node adapter for `GitPort`, driving the `git` CLI. Owns every git process
// spawn used by the publish flow; the orchestration policy lives in
// core/app/publishService.ts. The sync probes (hasGitSync/isGitRepoSync) back
// the GitCli port methods used on the synchronous-feeling adapter paths.

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr || e.message }));
    p.on("exit", (c) => resolve({ code: c ?? -1, stdout, stderr }));
  });
}

async function must(cmd: string, args: string[], cwd: string, label: string): Promise<string> {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0)
    throw new Error(`${label}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** Whether git is available on PATH (sync, for the preflight panel). */
export function hasGitSync(): boolean {
  try {
    return !spawnSync("git", ["--version"], { windowsHide: true }).error;
  } catch {
    return false;
  }
}

/** Whether `root` is inside a git work tree (sync, for the preflight panel). */
export function isGitRepoSync(root: string): boolean {
  try {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
    });
    return !r.error && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** `GitPort` over the git CLI. */
export class GitCli implements GitPort {
  async isInstalled(): Promise<boolean> {
    return hasGitSync();
  }

  async isRepo(root: string): Promise<boolean> {
    return isGitRepoSync(root);
  }

  async init(root: string): Promise<void> {
    await must("git", ["init"], root, "git init");
    await must("git", ["branch", "-M", "main"], root, "git branch");
  }

  async addAll(root: string): Promise<void> {
    await must("git", ["add", "-A"], root, "git add");
  }

  async hasChanges(root: string): Promise<boolean> {
    const status = await run("git", ["status", "--porcelain"], root);
    return Boolean(status.stdout.trim());
  }

  // Best-effort by design: the original flow ignored a commit failure (e.g. an
  // empty tree) and let the subsequent push surface any real problem.
  async commit(root: string, message: string): Promise<void> {
    await run(
      "git",
      [
        "-c",
        "user.email=noreply@dcs-studio",
        "-c",
        "user.name=DCS Studio",
        "commit",
        "-m",
        message,
      ],
      root,
    );
  }

  async getRemoteUrl(root: string, remote = "origin"): Promise<string | null> {
    const r = await run("git", ["remote", "get-url", remote], root);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  // Best-effort by design: `remote add` fails when the remote already exists,
  // which the original flow ignored (the existing remote is then pushed to).
  async setRemote(root: string, remote: string, url: string): Promise<void> {
    await run("git", ["remote", "add", remote, url], root);
  }

  async push(root: string, remote: string, ref: string): Promise<void> {
    await must("git", ["push", "-u", remote, ref], root, "git push");
  }
}
