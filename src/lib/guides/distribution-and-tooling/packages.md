# Packages

The **Packages** panel turns the open project into a signed, shareable `.dcspkg` artifact, and installs or removes packages other people have shared with you. A package is signed when it is built and re-checked every time it is installed or revalidated, which is what lets a revoked author's work be pulled from trust everywhere at once.

## Where the controls live

The panel header has two controls:

- **Pack this project** — builds a `.dcspkg` from the open project.
- A **Refresh** button — re-scans for packages and re-checks the trust of installed ones.

Below them are two lists, **Available** (packages waiting to be installed) and **Installed** (packages currently deployed). Failures surface in a banner at the top of the panel.

## What is inside a package

A `.dcspkg` is a compressed archive holding three things:

- a **manifest** — the package name, version, author, creation time, a content hash over the whole file tree, and the project's `[[install]]` rules;
- a **signature** over that manifest, issued by the signing server;
- the **source files** those install rules point at.

Because the signature covers the manifest and the content hash covers the files, altering either one after signing breaks the signature — and a broken signature will not install.

## Packing your project

1. Open the project. **Pack this project** is disabled until a project is open, and while another package task is running.
2. Be signed in. Packaging is gated on a logged-in author, because only an identified author can sign a package — see the **GitHub sign-in** guide.
3. Declare at least one `[[install]]` rule in the project's `dcs-studio.toml`. A project with no install rules has nothing to package. See the **Installer** guide for how those rules work.
4. Click **Pack this project**. DCS Studio gathers the rule's source files, hashes them into the manifest, asks the signing server to sign it, and writes the `.dcspkg`.

If you are not logged in, or the project declares no install rules, packing is refused with an error in the banner.

## Installing a shared package

Packages are discovered automatically — drop a `.dcspkg` into the incoming folder and it appears under **Available** with its name and author. When the folder is empty the list reads *"No packages in the incoming folder."*

Click the **Install** button on a package's row. Installation is deliberately strict:

1. The archive is unzipped to a staging area and its manifest is read.
2. The payload's hash is recomputed; if it no longer matches the signed manifest, the files were tampered with and the install is refused before anything is linked.
3. The signing server validates the signature; if it is invalid, or the author has been revoked, the install is refused.
4. The payload is moved into a content store and each install rule's destination is linked into it (a directory junction or file symlink, falling back to a copy), recording a ledger of exactly what was placed.

Installed packages then appear under **Installed**. The **Uninstall** button on a row removes precisely what the ledger recorded.

## Trust: revoked and unverified

Installed packages are re-validated against the signing server when the panel opens and whenever you press **Refresh**:

- A package whose author has since been **revoked** gets a red `revoked` badge — *"The author was revoked — this package is no longer trusted."* Revocation is global and retroactive: once an author is revoked, every package they ever signed becomes uninstallable, no matter who reshared it.
- If the signing server cannot be reached, the package is marked **unverified** — *"The signing server could not be reached — trust unconfirmed"* — rather than being quietly treated as trusted. Trust fails closed; a server outage never silently clears a revoked package.
- Packages by authors who have not been revoked stay installable regardless of who passed them along.

## Tips and troubleshooting

- **Refresh** re-scans the incoming folder and re-validates everything installed — use it after dropping in a new file or to pick up a fresh revocation.
- Manual file placement through the **Installer** is the unsigned, unrevocable escape hatch; a signed package is the trustworthy path.
- To produce the files a package ships first, see the **Build** guide (Rust projects) and the **Dependencies** guide (bundled Lua). To hand a finished `.dcspkg` to other people, see the **Publish & Share** guide.
