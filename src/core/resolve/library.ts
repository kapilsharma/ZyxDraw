import { Diagnostics } from "../diagnostics";
import { parse } from "../syntax/parser";
import { libraryFile, libraryNameProblem } from "../syntax/library-name";

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

/** True for a library file (`.zyxdl`), which draws nothing and may be imported. */
export function isLibraryPath(path: string): boolean {
  return path.endsWith(".zyxdl");
}

/**
 * Where an import may point to, in order: the folder of the importing file, then the library
 * folder from the settings. Empty when the library name has a problem (reported by the parser).
 */
export function importCandidates(fromPath: string, name: string, libraryFolder = ""): string[] {
  if (libraryNameProblem(name)) return [];
  const file = libraryFile(name);
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const out = [normalizePath(dir ? `${dir}/${file}` : file)];
  const folder = normalizePath(libraryFolder);
  if (folder) {
    const shared = `${folder}/${file}`;
    if (!out.includes(shared)) out.push(shared);
  }
  return out;
}

/** `shapes/system.zyxdl` -> `shapes/system.zyxd`: where a drawing imported by mistake would be. */
export function drawingPath(libraryPath: string): string {
  return libraryPath.slice(0, -1);
}

/**
 * Loads every library a drawing needs (and the libraries those need), so the rest of the
 * pipeline can run synchronously. The only async step in the core. Cycles are not an error
 * here (each file is read once); `resolve` reports them.
 *
 * When a library is found nowhere, the drawings (`.zyxd`) at the same places are read too, so
 * `resolve` can say "this is a drawing, rename it".
 */
export async function loadLibraries(source: string, path: string, read: ReadFile, libraryFolder = ""): Promise<Map<string, string>> {
  const libraries = new Map<string, string>();
  const missing = new Set<string>();
  const queue: { from: string; source: string }[] = [{ from: path, source }];

  const tryRead = async (candidate: string): Promise<string | null> => {
    if (libraries.has(candidate)) return libraries.get(candidate)!;
    if (missing.has(candidate)) return null;
    const content = await read(candidate);
    if (content === null) missing.add(candidate);
    else libraries.set(candidate, content);
    return content;
  };

  while (queue.length > 0 && libraries.size < MAX_LIBRARY_FILES) {
    const { from, source: text } = queue.shift()!;
    const tree = parse(text, new Diagnostics());
    for (const s of tree.statements) {
      if (s.kind !== "import" || !s.importPath) continue;
      const candidates = importCandidates(from, s.importPath, libraryFolder);
      let found = false;
      for (const candidate of candidates) {
        if (candidate === path) {
          found = true;
          break;
        }
        const known = libraries.has(candidate);
        const content = await tryRead(candidate);
        if (content === null) continue;
        if (!known) queue.push({ from: candidate, source: content });
        found = true;
        break;
      }
      if (!found) for (const candidate of candidates) await tryRead(drawingPath(candidate));
    }
  }
  return libraries;
}
