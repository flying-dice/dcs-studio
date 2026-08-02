import { spawn } from "child_process";
import { gitArgs } from "../../core/domain/cliArgs";
import type { GitPort } from "../../core/ports/git";

// Node adapter for `GitPort`, driving the `git` CLI. Owns every git process
// spawn used by the publish flow; the orchestration policy lives in
// core/app/publishService.ts. Every probe is async: the presence/repo probes
// used to spawn synchronously and froze the extension host while a cold git
// started up.

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, cwd ? { cwd, windowsHide: true } : { windowsHide: true });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d.toString()));
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr || e.message }));
      p.on("exit", (c) => resolve({ code: c ?? -1, stdout, stderr }));
    } catch (e) {
      // spawn can throw outright (EACCES, bad options); the probes run as the
      // publish panel opens and must degrade to "not available", never throw.
      resolve({ code: -1, stdout: "", stderr: (e as Error).message });
    }
  });
}

async function must(cmd: string, args: string[], cwd: string, label: string): Promise<string> {
  const r = await run(cmd, args, cwd);
  if (r.code !== 0)
    throw new Error(`${label}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** `GitPort` over the git CLI. */
export class GitCli implements GitPort {
  async isInstalled(): Promise<boolean> {
    return (await run("git", gitArgs.version())).code === 0;
  }

  async isRepo(root: string): Promise<boolean> {
    const r = await run("git", gitArgs.isRepo(), root);
    return r.code === 0 && r.stdout.trim() === "true";
  }

  async init(root: string): Promise<void> {
    await must("git", gitArgs.init(), root, "git init");
    await must("git", gitArgs.branchMain(), root, "git branch");
  }

  async addAll(root: string): Promise<void> {
    await must("git", gitArgs.addAll(), root, "git add");
  }

  async hasChanges(root: string): Promise<boolean> {
    const status = await run("git", gitArgs.status(), root);
    return Boolean(status.stdout.trim());
  }

  // Best-effort by design: the original flow ignored a commit failure (e.g. an
  // empty tree) and let the subsequent push surface any real problem.
  async commit(root: string, message: string): Promise<void> {
    await run("git", gitArgs.commit(message), root);
  }

  async getRemoteUrl(root: string, remote = "origin"): Promise<string | null> {
    const r = await run("git", gitArgs.getRemoteUrl(remote), root);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  // Best-effort by design: `remote add` fails when the remote already exists,
  // which the original flow ignored (the existing remote is then pushed to).
  async setRemote(root: string, remote: string, url: string): Promise<void> {
    await run("git", gitArgs.remoteAdd(remote, url), root);
  }

  async push(root: string, remote: string, ref: string): Promise<void> {
    await must("git", gitArgs.push(remote, ref), root, "git push");
  }
}
