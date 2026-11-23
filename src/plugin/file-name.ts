// Checks a name typed for a new drawing. No Obsidian imports, so tests can check it.

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

/** `Untitled`, or `Untitled 1`, `Untitled 2`, ... when taken. */
export function freeName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 1; ; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
}
