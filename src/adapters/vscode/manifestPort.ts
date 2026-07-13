import * as vscode from "vscode";
import * as path from "path";
import type { ManifestPort } from "../../core/ports/manifest";
import type { ManifestModel, InstallRoots } from "../../core/domain/types";

// VS Code adapter for `ManifestPort`, wrapping the shipped media/manifest-core.js
// UMD. The module is resolved lazily on first use so activation never pays the
// require cost (disable/unsubscribe flows never touch the manifest).

/** Load the shipped UMD manifest core (parse/emit/resolveDest) from the bundle. */
export function manifestCore(ctx: vscode.ExtensionContext): {
  parseToml: (t: string) => ManifestModel;
  emitToml: (m: ManifestModel) => string;
  resolveDest: (dest: string, roots: { savedGames: string; gameInstall: string }) => string | null;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(ctx.extensionUri.fsPath, "media", "manifest-core.js"));
}

export class VsCodeManifestPort implements ManifestPort {
  private core: ReturnType<typeof manifestCore> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** Resolve (and memoise) the UMD core the first time a method needs it. */
  private resolved(): ReturnType<typeof manifestCore> {
    return (this.core ??= manifestCore(this.ctx));
  }

  parseToml(text: string): ManifestModel {
    return this.resolved().parseToml(text);
  }

  emitToml(model: ManifestModel): string {
    return this.resolved().emitToml(model);
  }

  resolveDest(dest: string, roots: InstallRoots): string | null {
    return this.resolved().resolveDest(dest, roots);
  }
}
