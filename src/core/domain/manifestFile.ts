/**
 * The project manifest's filename, stated once.
 *
 * It is a contract, not a preference: `dcs-studio-project`'s Rust parser looks
 * for this exact name, a published release carries it as an asset, and the
 * marketplace decides whether a repo is a mod by whether that asset is there.
 * It was previously declared three times under two names and written out as a
 * bare literal in eight more places — nothing catches a typo in any of those,
 * because every one of them fails the same way a missing manifest does.
 */
export const MANIFEST_FILE = "dcs-studio.toml";
