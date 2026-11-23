import { Diagnostics } from "../diagnostics";
import { parse } from "../syntax/parser";

/** Reads a file by vault path. Returns null if it does not exist. */
export type ReadFile = (path: string) => Promise<string | null>;

/** Safety limit on how many library files one drawing may pull in. */
export const MAX_LIBRARY_FILES = 100;

/** `a/./b/../c` -> `a/c`. No leading slash. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/**
 * Where an import may point to, in order: relative to the importing file, then from the vault
 * root. `.zyxd` is added when missing. A leading `/` means vault root only.
 */
export function importCandidates(fromPath: string, importPath: string): string[] {
  const withExt = /\.zyxd$/i.test(importPath) ? importPath : `${importPath}.zyxd`;
  if (withExt.startsWith("/")) return [normalizePath(withExt)];
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const relative = normalizePath(dir ? `${dir}/${withExt}` : withExt);
  const root = normalizePath(withExt);
  return relative === root ? [relative] : [relative, root];
}

/**
 * Loads every library a drawing needs (and the libraries those need), so the rest of the
 * pipeline can run synchronously. The only async step in the core. Cycles are not an error
 * here (each file is read once); `resolve` reports them.
 */
export async function loadLibraries(source: string, path: string, read: ReadFile): Promise<Map<string, string>> {
  const libraries = new Map<string, string>();
  const missing = new Set<string>();
  const queue: { from: string; source: string }[] = [{ from: path, source }];

  while (queue.length > 0 && libraries.size < MAX_LIBRARY_FILES) {
    const { from, source: text } = queue.shift()!;
    const tree = parse(text, new Diagnostics());
    for (const s of tree.statements) {
      if (s.kind !== "import" || !s.importPath) continue;
      for (const candidate of importCandidates(from, s.importPath)) {
        if (candidate === path || libraries.has(candidate)) break;
        if (missing.has(candidate)) continue;
        const content = await read(candidate);
        if (content === null) {
          missing.add(candidate);
          continue;
        }
        libraries.set(candidate, content);
        queue.push({ from: candidate, source: content });
        break;
      }
    }
  }
  return libraries;
}
