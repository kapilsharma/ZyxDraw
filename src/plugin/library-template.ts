// The text of a new library (issue #22). No Obsidian imports, so tests can check it.

/**
 * A short guide in comments, and one custom shape, so the library is useful at once.
 * `name` is the library name typed in the dialog, such as `cloud.aws`: the name drawings in
 * the same folder (or the library folder) import it by.
 */
export function libraryTemplate(name: string): string {
  return `# ZyxDraw library: shapes, styles, gradients and clips for drawings to use.
# A library draws nothing on its own. Use its shapes in a drawing with:
#   import card from ${name}
#
# With no \`export\` line, everything here can be imported, also names this library imports.
# To keep some names private, list the ones to share:
#   export card

card is shape(label, width=140, height=70, color=#dbe8fb):
  body is rect(width=100%, height=100%, rx=8, fill=color, stroke=#3b6db3, stroke-width=2)
  title is text(label, x=50%, y=50%, align=middle)

# Example uses, shown when this library is open in ZyxDraw. Drawings never draw them.
# Select a shape there to try other values: they are written here.
preview():
  card(label="Card")
`;
}
