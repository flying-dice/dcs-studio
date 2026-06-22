// The single source of the app's version for display surfaces (the About
// dialog, the Welcome footer). Read from package.json at build time — Vite
// bundles the JSON and `resolveJsonModule` is on — so the version is declared
// ONCE and never retyped per surface. package.json and crates/app/tauri.conf.json
// carry the same version; this is the frontend's view of it.
import { version } from "../../package.json";

export const APP_VERSION: string = version;
