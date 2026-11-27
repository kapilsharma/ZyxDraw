// Checks a name typed for a new drawing or library. No Obsidian imports, so tests can check it.
import { libraryNameProblem } from "../core";

/** Characters no file name may contain (Windows, macOS, Linux, mobile). */
const FORBIDDEN = /[\\/:*?"<>|]/;
/** Characters that break `[[links]]` and `![[embeds]]` to the file. */
const BREAKS_LINKS = /[#^[\]]/;

/**
 * The file name (without extension) for what the user typed, or the problem with it.
 * A typed `.zyxd` at the end is dropped, so "plan.zyxd" and "plan" give the same file.
 */
export function drawingBaseName(typed: string, extension: string): { name: string } | { problem: string } {
  let name = typed.trim();
  const ext = `.${extension}`;
  if (name.toLowerCase().endsWith(ext)) name = name.slice(0, -ext.length).trim();
  if (name === "") return { problem: "Enter a name" };
  const bad = FORBIDDEN.exec(name) ?? BREAKS_LINKS.exec(name);
  if (bad) {
    const why = FORBIDDEN.test(bad[0]) ? "cannot be used in file names" : "would break links to the file";
    return { problem: `\`${bad[0]}\` ${why}` };
  }
  if (name.startsWith(".")) return { problem: "A name starting with `.` makes a hidden file" };
  return { name };
}

/**
 * The library name for what the user typed, or the problem with it (issue #22).
 * It follows the import rules, so the name typed is the name drawings import:
 * `cloud.aws` is the file `cloud/aws.zyxdl`. A typed `.zyxdl` at the end is dropped.
 */
export function libraryBaseName(typed: string): { name: string } | { problem: string } {
  let name = typed.trim();
  if (name.toLowerCase().endsWith(".zyxdl")) name = name.slice(0, -".zyxdl".length).trim();
  if (name === "") return { problem: "Enter a name" };
  if (/\s/.test(name)) return { problem: "A library name cannot contain spaces: use `_`, like `my_shapes`" };
  const problem = libraryNameProblem(name);
  return problem ? { problem } : { name };
}

/** A folder as the vault shows it: its files and folders (only folders have `children`). */
export interface FolderLike {
  children: { name: string; children?: unknown }[];
}

/**
 * Whether `path` (from the vault root, `a/b/c.zyxd`) is taken, ignoring upper and lower case as
 * Windows and macOS do (issue #44). Only the folders on the path are read, one level at a time:
 * never the whole vault.
 */
export function pathTaken(root: FolderLike, path: string): boolean {
  const parts = path.split("/").filter((p) => p !== "");
  let folder: FolderLike | undefined = root;
  for (let i = 0; i < parts.length && folder; i++) {
    const part = parts[i].toLowerCase();
    const child: { name: string; children?: unknown } | undefined = folder.children.find((c) => c.name.toLowerCase() === part);
    if (!child) return false;
    if (i === parts.length - 1) return true;
    folder = Array.isArray(child.children) ? (child as FolderLike) : undefined;
  }
  return false;
}

/** `Untitled`, or `Untitled 1`, `Untitled 2`, ... when taken. Libraries use `_` (no spaces). */
export function freeName(base: string, taken: (name: string) => boolean, separator = " "): string {
  if (!taken(base)) return base;
  for (let i = 1; ; i++) if (!taken(`${base}${separator}${i}`)) return `${base}${separator}${i}`;
}
