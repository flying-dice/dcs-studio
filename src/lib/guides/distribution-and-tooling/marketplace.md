# Marketplace

The **Marketplace** is a full-screen storefront for discovering DCS Studio mods that the community has published to GitHub. You browse a grid of mods, open any one to read its README and install plan, and install it straight into your DCS folders.

## Opening the Marketplace and signing in

The Marketplace is a separate full-screen view reached from the DCS Studio launcher; the back arrow in its top-left returns you there.

Browsing requires a GitHub sign-in. Until you sign in, the Marketplace shows a locked wall headed **"Sign in to browse the Marketplace"** with the note:

> The Marketplace discovers community mods from GitHub. Sign in with your GitHub account to browse — it's free and uses your account only to search.

Sign in using the button on that wall. The store loads automatically as soon as you are signed in. See the **GitHub sign-in** guide for the sign-in steps.

## Browsing, searching, and sorting

Once signed in, a toolbar sits above the card grid:

- **Search mods…** — a search box that filters the loaded mods by name, author, description, or label as you type.
- **All tags** — a dropdown that narrows the grid to a single label. Clicking any label chip on a card also sets this filter.
- **Most stars / Name** — a sort dropdown, ordering the grid by GitHub stars or alphabetically.
- **Refresh** — re-runs discovery against GitHub.

Each result is a card showing the owner's avatar, the mod name, **by `<author>`**, its GitHub star count, a short description, and its labels. A mod that is a dependency-only library carries a small **library** badge. Each card has a **Details** button (and the card body itself) that opens the mod's page, and a **GitHub** link that opens the repository in your browser.

If nothing matches your filter, the grid shows **"No mods match your search."**; if discovery found nothing at all it shows **"No mods found. Publish one by tagging your GitHub repo `dcs-studio`."**

### How discovery works

A mod is simply any public GitHub repository carrying the `dcs-studio` topic. Discovery searches that topic as your signed-in user, and the repository's other topics become the labels you can filter by. Results are cached for a short time, so reopening the store is instant and a momentary network or rate-limit problem falls back to the last results rather than failing. **Refresh** forces a fresh search. To publish your own mod into this store, see the **Publish & Share** guide.

## The mod page

Opening a card shows the mod's product page: a header with the avatar, name, author, star count, and release tag; the description; and the rendered **Readme** (or "This repo has no README." when there is none). The **Refresh** button in the top bar re-fetches the mod from GitHub. The aside on the right holds the install action plus details.

### Installing a mod

The action depends on the mod:

- For an installable mod, an **Install** button downloads and deploys it. While it runs, a progress card shows **Downloading** then **Linking** for each item, with a progress bar and an `Installing N of M` count and a **Cancel** button. The page explains: "Links the files into your DCS folders (no copy); uninstall removes the links."
- Once installed, the page shows **Installed** with an **Uninstall** button that removes it.
- A mod whose latest release ships no manifest shows **"Not installable — this release ships no `dcs-studio.toml`."**
- A **Library** shows an **Add as dependency** button instead, which writes the mod into your project's `CargoLua.toml` rather than installing it into DCS. This needs a project open; otherwise it prompts **"Open a project first to add this as a dependency."** See the **Dependencies** guide.

Installing a mod also pulls in any other Marketplace mods it declares as dependencies. When present, a **Dependencies** panel lists them (headed "Installing this also installs…"). For exactly how files are placed into your DCS folders — junctions, hard links, and symlinks rather than copies — see the **Installer** guide.

### Download and install plan

Two more panels describe what you would get:

- **Download** lists the total download size and each release asset with its size (or "No release assets.").
- **Install plan** lists every `source → destination` mapping the mod declares (or "Installable, but declares no install rules."), so you can see exactly what lands where before installing.

A **View on GitHub** link at the bottom opens the repository.

## Tips and troubleshooting

- The Marketplace lists a tagged repository whether or not it can actually be installed — installability depends on the latest release shipping a `dcs-studio.toml` manifest, which is resolved when you open the mod page.
- A version mismatch on a dependency does not block an install; the Marketplace serves each repo's latest release and surfaces a warning instead.
- If discovery shows an error banner, **Refresh** retries; where possible the last cached listings are still shown beneath it.
