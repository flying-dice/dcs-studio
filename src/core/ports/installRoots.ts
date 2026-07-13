// Port: the DCS install roots + the extension's data dir. The adapter reads VS
// Code settings and falls back to platform defaults. Reads are synchronous.

export interface InstallRootsPort {
  /** The DCS Saved Games write dir (the `{SavedGames}` root). */
  savedGames(): string;
  /** The DCS game-install dir (the `{GameInstall}` root), or undefined if unset. */
  gameInstall(): string | undefined;
  /** The DCS Studio data dir where mods are downloaded and unpacked. */
  dataDir(): string;
}
