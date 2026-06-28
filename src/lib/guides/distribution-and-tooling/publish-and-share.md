# Publish & Share

The **Publish & Share** panel turns the project you have open into a public GitHub repository and, optionally, cuts a downloadable release so the mod appears in the DCS Studio Marketplace. It drives two distinct actions: *Share on GitHub* (create and push the repository) and *Publish a release* (upload the install payload as a GitHub release).

## Before you start

The panel only works when two conditions are met, and it tells you which one is missing:

- If no project is open, it shows **"Open a project to publish it."** — open a project first.
- If you are not signed in to GitHub, it shows **"Sign in with GitHub (top-right) to publish this project."** — use the GitHub chip in the top-right of the window. See the **GitHub sign-in** guide.

Signing in for the first time grants only read-only access to your identity. Publishing needs permission to write to your repositories, so the first time you share or release, DCS Studio asks you to grant that extra access (see *Authorizing publishing* below).

## Sharing a project to GitHub

When the project has not been shared yet, the **Share on GitHub** section offers:

- A **Publish as library (dependency-only, not installable)** checkbox. Tick this when the project is a code library meant to be consumed as a dependency rather than installed into DCS. A library is still discoverable in the Marketplace, but it is marked so it can only be added as a dependency, never installed.
- A **Share on GitHub** button.

Pressing **Share on GitHub** creates a public, world-readable repository under your GitHub account, gives it the `dcs-studio` topic (the marker the Marketplace searches for), commits the project's files locally, and pushes them. The panel shows this warning before you act:

> ⚠ Creates a public, world-readable repo tagged `dcs-studio` and pushes this project's files to it.

When you publish as a library, the repository is additionally tagged `dcs-studio-library`.

Once sharing succeeds, the section instead shows the repository's full name with two links: **Repo** (opens it on GitHub) and **View in Marketplace** (jumps to its Marketplace page). Sharing is idempotent — if the repository already exists, DCS Studio reuses it and re-pushes, so a retry after a partial failure is safe.

## Authorizing publishing

The initial GitHub sign-in is read-only. The first time you share or release, DCS Studio escalates to write access and shows an **Authorize publishing** card:

1. It displays a one-time code under the prompt **"Enter this code at GitHub to grant repo access:"**.
2. Click **Open** to open GitHub in your browser, and enter the code there.
3. The card shows **"Waiting for authorization…"** until you approve; **Cancel** abandons the request.

If you decline in the browser, the publish is cancelled and nothing changes on GitHub. This is the same OAuth device-code mechanism as the initial sign-in — see the **GitHub sign-in** guide.

## Publishing a release

The **Publish a release** section has a tag field (it starts at `v0.1.0`) and a **Release** button. Type the version tag you want, then press **Release**.

While the release runs, a progress card shows the current step:

- **Packaging payload…** — bundling the manifest and files.
- **Splitting into volumes…** — splitting a large payload into parts.
- **Creating draft release…** — creating a hidden draft on GitHub.
- **Uploading assets…** — uploading, with a progress bar and a running byte and part count.
- **Publishing release…** — flipping the finished draft to public.

You can **Cancel** at any point; cancelling mid-upload removes the draft and leaves nothing published. When it finishes, the panel shows **"Released `<tag>` 🎉"** with a **Release** link (the GitHub release) and an **Open Marketplace** button. Before you publish, the section notes:

> Uploads `dcs-studio.toml` so the Marketplace shows the install plan.

### What gets uploaded

DCS Studio packages the project's `dcs-studio.toml` manifest plus every file named by the manifest's install rules into a 7-Zip payload, then uploads them as the release's assets:

- The `dcs-studio.toml` manifest is always uploaded as its own standalone asset, so the Marketplace can read the install plan without downloading the whole payload.
- A small payload ships as one `dcs-studio-<name>-<tag>.7z` file. A large one is split into ordered `dcs-studio-<name>-<tag>.7z.001`, `.002`, … volumes, which anyone can reassemble with the standalone 7-Zip tool (`7z x dcs-studio-<name>-<tag>.7z.001`).
- A project with no install rules publishes the manifest alone, with no payload.

See the **Packages** guide for what the `dcs-studio.toml` manifest declares, and the **Marketplace** guide for how others discover and install what you publish.

## Tips and troubleshooting

- **Packaging happens before GitHub is touched.** If packaging fails (for example a missing install source, or a symlink in a source tree, which is refused outright), no release is created and the error names the failing step.
- **Re-publishing the same tag is safe.** A release is created as a hidden draft and only flipped to public once every asset has uploaded. If a publish fails partway, the draft is left in place; publishing that tag again reuses the draft and replaces its assets rather than duplicating them.
- **A failed publish and a cancelled one differ.** A genuine failure leaves the draft so a re-publish stays idempotent; an explicit **Cancel** rolls the run back and leaves nothing.
- **Sharing relies on local `git`.** The commit and push use the `git` program installed on your machine, so the share step fails if `git` is not installed.
- Errors appear in red at the bottom of the panel.
