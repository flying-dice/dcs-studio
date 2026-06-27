# GitHub sign-in

Signing in to GitHub is optional — DCS Studio is fully usable without it. Signing in connects your GitHub account so you can browse the Marketplace, sign the packages you publish, and share projects and releases.

## Where to sign in

The GitHub control is a chip in the top-right of the DCS Studio window. When you are signed out it reads **Sign in** (with a sign-in icon). The Marketplace offers the same control on its sign-in wall.

## How signing in works

DCS Studio uses GitHub's **OAuth device flow** — you authorize the app on github.com by entering a short code, so no password is ever typed into DCS Studio. Pressing **Sign in** opens a modal titled **"Sign in to GitHub"** that notes:

> Signing in is optional — the rest of DCS Studio works without it. It lets you sign the packages you publish under your GitHub identity.

The modal walks you through three numbered steps:

1. **Copy this one-time code** — a short code is shown; a **Copy** button copies it (it briefly changes to **Copied**). You can also select it by hand.
2. **Open GitHub and paste the code** — a link opens GitHub's device page (`github.com/login/device`) in your browser, where you paste the code.
3. **Authorize DCS Studio** — back on GitHub, approve the request. The modal shows **"Waiting for you to authorize in the browser…"** until you do.

As soon as you approve, the modal closes and the chip becomes your GitHub profile. You can press **Cancel** (or Escape, or click outside the modal) to stop at any point. If you cancel, a code you happen to authorize in the browser afterwards is ignored and does not sign you in.

If something goes wrong, the modal shows **"Sign-in didn't complete."** with the reason and a **Try again** button.

### What is stored

The sign-in grants only read access to your GitHub identity (the `read:user` scope) — enough to know who you are and to sign packages under your identity. The access token itself is held securely by the desktop app and is never exposed to the in-app web view, which only ever sees your public profile (your login name and avatar). Because that profile is cached, a previous sign-in keeps working offline without re-authorizing.

## What signing in unlocks

- **Browsing the Marketplace.** The store is gated; signing in lets you search and open mods. See the **Marketplace** guide.
- **Signing published packages** under your GitHub identity.
- **Sharing and publishing.** Creating a repository or cutting a release needs write access, which is more than the read-only sign-in grants. The first time you publish, DCS Studio asks you to authorize the additional `public_repo` scope through the same device-code flow; declining cancels the publish and changes nothing. See the **Publish & Share** guide.

## Signing out

When you are signed in, the chip shows your GitHub login and avatar. Click it to open the menu and choose **Sign out**, which clears the cached token and profile and returns the chip to its signed-out **Sign in** state.

## Tips and troubleshooting

- Sign-in never blocks the IDE — the modal is only modal while open, and you can dismiss it and keep working.
- If the code expires before you authorize, or you decline on GitHub, the modal reports that sign-in didn't complete; press **Try again** for a fresh code.
- Only one sign-in runs at a time: starting a new sign-in supersedes any earlier attempt, so an old code left open in a browser tab will not sign you in.
