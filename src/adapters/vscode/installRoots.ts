import { gameInstallDir, savedGamesDir } from "../../bridge/paths";
import type { InstallRootsPort } from "../../core/ports/installRoots";
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
