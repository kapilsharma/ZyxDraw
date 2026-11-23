import { App, TFile } from "obsidian";
import { compileWithImports, type CompileResult, type ReadFile, type TextMeasurer } from "../core";

/** Reads `.zyxd` libraries from the vault. */
export function vaultReader(app: App): ReadFile {
  return async (path: string) => {
    const file = app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? app.vault.cachedRead(file) : null;
  };
}

/** Compiles a drawing, loading its imports from the vault (relative to `path`). */
export function compileInVault(
  app: App,
  source: string,
  path: string,
  options: { measurer?: TextMeasurer; metadata?: boolean } = {},
): Promise<CompileResult> {
  return compileWithImports(source, vaultReader(app), { ...options, path });
}
