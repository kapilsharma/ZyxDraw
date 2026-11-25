/**
 * Library names: the dotted path after `from` in an import, such as `shapes.system` for the file
 * `shapes/system.zyxdl`. Folder and file names use only letters, digits, `-` and `_`, so a dot
 * always means a folder.
 */

const PART = /^[A-Za-z0-9_-]+$/;

/** The problem with a library name, or null when it is fine. */
export function libraryNameProblem(name: string): string | null {
  const ext = /\.zyxdl?$/i.exec(name);
  const bare = ext ? name.slice(0, ext.index) : name;
  const parts = bare.split(/[\\/]/);

  if (parts.includes("..")) {
    return "A library cannot be in a parent folder (`..`). Put it next to the drawing, or in the library folder";
  }
  const suggestion = parts.filter((p) => p !== "" && p !== ".").join(".");
  const fixable = suggestion.split(".").every((p) => PART.test(p));
  if (ext) {
    return fixable
      ? `Leave out the extension: write \`${suggestion}\`. Only \`.zyxdl\` libraries can be imported`
      : "Leave out the extension. Only `.zyxdl` libraries can be imported";
  }
  if (parts.length > 1) {
    return fixable ? `Folders are separated by dots: write \`${suggestion}\`` : "Folders are separated by dots, like `shapes.system`";
  }
  if (!name.split(".").every((p) => PART.test(p))) {
    return "A library name uses only letters, digits, `-` and `_`, with a dot between folders, like `shapes.system`";
  }
  return null;
}

/** `shapes.system` -> `shapes/system.zyxdl`. Only for names without a problem. */
export function libraryFile(name: string): string {
  return `${name.split(".").join("/")}.zyxdl`;
}
