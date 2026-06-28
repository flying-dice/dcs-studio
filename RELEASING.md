# Releasing dcs-studio

How a tagged version becomes an installable Windows build that shipped users
auto-update to. Implements issue #54.

## Architecture

- **Build + publish run on GitHub Actions, not GitLab CI.** The GitLab runners
  are Linux and cannot produce a Windows Tauri bundle; the public distribution
  surface is GitHub. The pipeline is `.github/workflows/release.yml`, triggered
  by a `v*` tag, building on `windows-latest`.
- **`origin` is GitLab; GitHub is a replication mirror.** Everyday pushes go to
  the GitLab `origin`; replication replays them to GitHub, and a *replicated*
  `v*` tag is what fires the workflow. A normal clone has **no GitHub remote** —
  the tag reaches GitHub through replication, not a direct push. Commands that
  talk to GitHub (the `gh` calls below) therefore target the repo explicitly
  with `-R flying-dice/dcs-studio`.
- **Distribution + updates run through GitHub Releases.** Each release carries
  the NSIS installer plus a signed `latest.json`. The app reads that feed
  (`crates/app/tauri.conf.json` → `plugins.updater.endpoints`) on startup and
  installs a newer signed build automatically (`check_for_updates`, `lib.rs`).
- **Target:** Windows x86_64 only (`bundle.targets: ["nsis"]`). No macOS/Linux.
- **The in-DCS bridge runtime ships in the bundle** (#70). `crates/dcs-bridge`
  builds `dcs_studio.dll`; `scripts/prepare-sidecar.mjs` (run by
  `beforeBuildCommand`) builds it `--release` and stages it as the
  `dcs_studio.dll` bundle resource (`crates/app/tauri.conf.json` →
  `bundle.resources`), so the installer drops it next to the app exe where the
  Injection Manager resolves it (`source_dll_path()`). Without it an installed
  release cannot inject or launch DCS. Two release guards enforce this: a static
  check that the resource is declared, and a post-build check that `pnpm sidecar`
  staged the DLL.
- **Code signing (Authenticate) is deferred** (#54). Updater signing (minisign,
  below) is separate and **required** — it is what makes auto-update trustworthy.

## One-time owner setup

These are not in code — they provision the GitHub side and the update trust
root. Do them once, before the first release.

1. **Generate the updater keypair.** The private key can push code to every
   installed copy, so it must be created and held by the owner — never committed,
   never echoed.
   ```bash
   pnpm tauri signer generate -w ~/.tauri/dcs-studio-updater.key
   ```
   - Put the printed **public key** into `crates/app/tauri.conf.json` →
     `plugins.updater.pubkey`, replacing the `REPLACE_ME__…` placeholder. The
     public key is safe to commit.
   - Keep the **private key** + its password out of git (store in the
     `Flying Dice` vault).

2. **Set up GitLab→GitHub replication** (GitHub is the public distribution
   surface; see Architecture) and confirm the org/repo in two places matches the
   real GitHub path:
   - `plugins.updater.endpoints` in `crates/app/tauri.conf.json`
   - `releaseName` / repo context in `.github/workflows/release.yml`
   The committed value assumes `github.com/flying-dice/dcs-studio` — correct it
   if the GitHub org differs. Confirm that replicated `v*` tags actually trigger
   Actions: a GitLab **push** mirror (GitLab pushing to GitHub with a token)
   does; a GitHub-side **pull** mirror may not (see Cutting a release, step 4).

3. **Add GitHub repository secrets** (Settings → Secrets and variables →
   Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/dcs-studio-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password from step 1

> Until the placeholder `pubkey` is replaced with the real public key, shipped
> clients cannot verify updates. Do step 1 before tagging a real release — the
> workflow checks for the `REPLACE_ME` placeholder and fail-closes if you forget.

## Cutting a release

### 1. Bump the version

The app version lives in **four** files — keep them aligned. Only
`tauri.conf.json` is load-bearing for the updater (its version is what the CI
guard checks and what `latest.json` advertises); the rest are for consistency:

- `crates/app/tauri.conf.json` → `version`  (drives the updater + installer; CI-checked)
- `Cargo.toml` → `[workspace.package] version`
- `crates/app/Cargo.toml` → `version`
- `package.json` → `version`  (npm metadata only; not read by Tauri)

A version bump changes the workspace crates' recorded versions, so refresh the
lockfile and commit it with the rest — otherwise the tagged commit carries a
stale `Cargo.lock`:

```bash
cargo update --workspace   # or: cargo check --workspace (regenerates Cargo.lock)
```

The workflow asserts the pushed tag (`vX.Y.Z`) equals `tauri.conf.json`'s
`version` and fail-closes on drift, so a forgotten bump aborts the release
instead of shipping a `latest.json` that advertises the wrong version.

### 2. Verify the build locally (recommended)

The release build path (`tauri build` + the NSIS bundler) is **not** run by
GitLab CI — the release workflow is the first thing to exercise it. Dry-run it
locally first so a failure costs a re-edit, not a burned tag. Build exactly as
CI does — a fresh, lockfile-faithful install is what surfaces a dependency that
`pnpm dev` resolves but a production build does not:

```bash
pnpm install --frozen-lockfile
pnpm tauri build --target x86_64-pc-windows-msvc
```

If the updater **private key** isn't on this machine, the signing step fails
(`tauri.conf.json` has `createUpdaterArtifacts: true`). That last step is the
one thing CI does that a local run can't, and it's gated by the repo secrets —
skip just it for a local-only check by overriding the config (no file edit):

```bash
pnpm tauri build -c '{"bundle":{"createUpdaterArtifacts":false}}' --target x86_64-pc-windows-msvc
```

A green run ends with `dcs-studio_X.Y.Z_x64-setup.exe` under
`target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

### 3. Commit, tag, and push

Push the branch **and** the tag. Pushing only the tag (per a typical
single-remote flow) does not advance `main` on `origin` — the release commit
would be reachable only via the tag. The tag is what triggers the workflow,
through replication (see Architecture):

```bash
git commit -am "release: vX.Y.Z"
git tag -a vX.Y.Z -m "dcs-studio vX.Y.Z"
git push origin main         # advance the release commit on origin (GitLab)
git push origin vX.Y.Z       # the tag → replicates to GitHub → triggers release.yml
```

### 4. Confirm it triggered, then watch it

Because the tag reaches GitHub indirectly, verify the tag landed and the run
started before assuming the release is underway (`gh auth login` once):

```bash
gh api repos/flying-dice/dcs-studio/git/refs/tags/vX.Y.Z      # tag replicated to GitHub?
gh run list -R flying-dice/dcs-studio --workflow release.yml -L 5
gh run watch <run-id> -R flying-dice/dcs-studio --exit-status  # blocks until done; non-zero on failure
```

> If no run appears within a couple of minutes, the replication mirror probably
> isn't firing Actions (a GitHub-side *pull* mirror won't). Add a GitHub remote
> and push the tag to it directly:
> `git remote add github git@github.com:flying-dice/dcs-studio.git && git push github vX.Y.Z`.

### 5. Review and publish the draft

The workflow publishes a **draft** GitHub Release (`releaseDraft: true`) with the
NSIS installer, its `.sig`, and `latest.json` attached. Confirm all three assets
are present, install the `.exe` once to smoke-test, then publish — via the
Releases UI, or:

```bash
gh release view vX.Y.Z -R flying-dice/dcs-studio                 # inspect assets
gh release edit vX.Y.Z -R flying-dice/dcs-studio --draft=false   # publish
```

Publishing is what moves the release to `…/releases/latest` — the path the
updater feed resolves — so shipped clients begin seeing the update only once the
draft is published, not when the workflow finishes.

## How auto-update reaches users

On publish, `latest.json` at the release's `…/releases/latest/download/latest.json`
advertises the new version + the installer's signature. A running app checks
that feed on startup; if the advertised version is newer and its signature
verifies against the embedded public key, it downloads, installs, and relaunches.
A missing or unreachable feed (offline, or before the first release) is a logged
no-op — it never blocks startup.
