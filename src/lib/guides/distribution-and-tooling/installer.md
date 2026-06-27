# Installer

The Installer deploys a project's files to the right places on your machine by following the `[[install]]` rules in its `dcs-studio.toml` manifest. Each rule says which file or folder to copy and where it should land, so installing a mod is a single click rather than manual file shuffling.

## Where to find it

The Install controls live in the **Output** tool window at the bottom of the IDE, alongside the Build button. It opens automatically when you build a project (for example via **Run → Build Project**), and you can toggle the bottom **Output** panel from the tool rail. The toolbar offers three actions:

- **Build** — compile the open project (Rust projects run `cargo build --release`); see the **Build** guide.
- **Install** — deploy the project per its `dcs-studio.toml` `[[install]]` rules.
- **Uninstall** — remove the files a previous install deployed. This stays disabled until something is actually installed.

Next to the buttons, a small status dot reports the current deployment state:

- grey **not installed** — none of the rule destinations exist yet;
- green **installed** — every destination is present and matches its source;
- amber **installed · outdated** — the project is installed, but a source has changed since, so the deployed copy is stale.

## How install rules work

A project declares one or more `[[install]]` tables in its `dcs-studio.toml`. Each table is a single mapping with two fields:

- `source` — a path relative to the project root (the file or folder to deploy);
- `dest` — a destination anchored to a named root.

```toml
[project]
name = "my-mod"
version = "1.0.0"

[[install]]
source = "mod.lua"
dest = "{SavedGames}/Mods"
```

Two named roots are resolved automatically at install time:

- `{SavedGames}` — your detected DCS *Saved Games* write directory;
- `{GameInstall}` — your detected DCS game-install directory.

When you click **Install**, the IDE reads every rule, resolves the roots, and copies each `source` to its resolved `dest`, creating any missing directories along the way. A manifest with no `[[install]]` rules is an error — there is nothing to deploy. The Output panel then logs what happened, for example:

```
Installed 1 file(s):
  + .../Saved Games/DCS/Mods/mod.lua
```

## Status, update, and uninstall

- **Status** is computed by checking each rule's destination. A project counts as *installed* if any destination file exists, and *up to date* only if every destination exists and its contents still match the source. A missing source marks that rule as not up to date — which is why editing a deployed file flips the status to amber **outdated**.
- **Re-installing** simply copies the current sources over the destinations again, bringing an outdated install back to green.
- **Uninstall** removes every file the rules placed, logging each removed path with a `-` prefix. File rules are removed by their source filename alone; directory rules need the source tree to still exist so the installer knows what to take back out.

## Rust-DLL mods

For a Rust project that builds a DLL with a GameGUI hook, installing deploys exactly like the built-in DCS bridge does: the compiled DLL lands under `Mods/tech` in your Saved Games write directory, and its hook lands under `Scripts/Hooks`. Build the project first (see the **Build** guide) so the DLL exists, then install.

## Tips and troubleshooting

- **Nothing to install?** Confirm your `dcs-studio.toml` actually contains at least one `[[install]]` table — without rules the action errors out.
- **Stuck on "outdated"?** Re-run **Install** to refresh the deployed copies.
- The IDE's **Install** action *copies* files into place. Installing a mod from the **Marketplace**, or a signed package (see the **Packages** guide), instead *links* each destination to a shared content store rather than copying — so those installs are managed separately from the manual deploy described here.
- The same `[[install]]` rules that drive this action are what get bundled when you package a project to share it; see the **Packages** and **Publish & Share** guides.
