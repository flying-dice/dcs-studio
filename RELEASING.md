# Releasing dcs-studio

How a tagged version becomes an installable Windows build that shipped users
auto-update to. Implements issue #54.

## Architecture

- **Build + publish run on GitHub Actions, not GitLab CI.** The GitLab runners
  are Linux and cannot produce a Windows Tauri bundle; the public distribution
  surface is GitHub. The pipeline is `.github/workflows/release.yml`, triggered
  by a `v*` tag, building on `windows-latest`.
- **Distribution + updates run through GitHub Releases.** Each release carries
  the NSIS installer plus a signed `latest.json`. The app reads that feed
  (`crates/app/tauri.conf.json` → `plugins.updater.endpoints`) on startup and
  installs a newer signed build automatically (`check_for_updates`, `lib.rs`).
- **Target:** Windows x86_64 only (`bundle.targets: ["nsis"]`). No macOS/Linux.
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

2. **Mirror the repo to GitHub** (public distribution surface) and confirm the
   org/repo in two places matches the real GitHub path:
   - `plugins.updater.endpoints` in `crates/app/tauri.conf.json`
   - `releaseName` / repo context in `.github/workflows/release.yml`
   The committed value assumes `github.com/flying-dice/dcs-studio` — correct it
   if the GitHub org differs.

3. **Add GitHub repository secrets** (Settings → Secrets and variables →
   Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/dcs-studio-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password from step 1

> Until the placeholder `pubkey` is replaced with the real public key, shipped
> clients cannot verify updates. Do step 1 before tagging a real release — the
> workflow checks for the `REPLACE_ME` placeholder and fail-closes if you forget.

## Cutting a release

1. **Bump the version.** The app version lives in three places — keep them
   aligned. The updater compares `tauri.conf.json`'s version, so that one is
   load-bearing:
   - `crates/app/tauri.conf.json` → `version`  (drives the updater + installer)
   - `Cargo.toml` → `[workspace.package] version`
   - `crates/app/Cargo.toml` → `version`

   The workflow asserts the pushed tag (`vX.Y.Z`) equals `tauri.conf.json`'s
   `version` and fail-closes on drift, so a forgotten bump aborts the release
   instead of shipping a `latest.json` that advertises the wrong version.

2. **Commit, tag, push the tag.** The tag triggers the release workflow.
   ```bash
   git commit -am "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin vX.Y.Z   # to the GitHub remote
   ```

3. **Review the draft release.** The workflow publishes a **draft** GitHub
   Release with the NSIS installer and `latest.json` attached. Verify the
   installer runs and the assets are present, then publish the release.

## How auto-update reaches users

On publish, `latest.json` at the release's `…/releases/latest/download/latest.json`
advertises the new version + the installer's signature. A running app checks
that feed on startup; if the advertised version is newer and its signature
verifies against the embedded public key, it downloads, installs, and relaunches.
A missing or unreachable feed (offline, or before the first release) is a logged
no-op — it never blocks startup.
