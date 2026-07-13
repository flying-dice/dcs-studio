import type { InstallRootsPort } from "../../core/ports/installRoots";
import { savedGamesDir, gameInstallDir } from "../../bridge/paths";
import { dataDir } from "../../install/dataDir";

// VS Code adapter for `InstallRootsPort`, delegating to the existing settings-aware
// path resolvers (bridge/paths.ts + install/dataDir.ts).
export class VsCodeInstallRoots implements InstallRootsPort {
  savedGames(): string {
    return savedGamesDir();
  }

  gameInstall(): string | undefined {
    return gameInstallDir();
  }

  dataDir(): string {
    return dataDir();
  }
}
