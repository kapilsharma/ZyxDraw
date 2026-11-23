/**
 * Hiding shapes with `display=none` (issue #2). A hidden shape is still laid out, so anchors and
 * lines to it keep working; it is only not painted, and the drawing view does not select it.
 */
import type { Scene } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import type { SourceRange } from "../syntax/ast";
import { allShapes, blank, canEdit, editableShape, normalizeEdits, StatementEditor, type EditResult } from "./edit";
import type { PropertyTarget } from "./properties";

/** One shape statement of the user's file, for the eye icons in the text editor. */
export interface Layer {
  path: string;
  /** The statement without its children. The eye goes on its first line. */
  range: SourceRange;
  /** The statement with its children: what is faded when it is hidden. */
  blockRange: SourceRange;
  /** `display=none` on this shape, written or from a style. */
  hidden: boolean;
  /** An enclosing group is hidden, so this shape is too. */
  hiddenByGroup: boolean;
}

/** The shape's own `display=none`, written or from a style. */
export function isHidden(s: Shape): boolean {
  const d = s.attrs.get("display");
  return d !== undefined && d.value.t === "str" && d.value.v === "none";
}

/** Not drawn: the shape or one of its groups is hidden. */
export function isHiddenInDrawing(s: Shape): boolean {
  for (let p: Shape | null = s; p; p = p.parent) if (isHidden(p)) return true;
  return false;
}

/** Every shape statement in the file, in text order. Parts of custom shapes are left out. */
export function layers(scene: Scene): Layer[] {
  const out: Layer[] = [];
  for (const s of allShapes(scene)) {
    if (s.generated) continue;
    out.push({
      path: s.path,
      range: s.source.range,
      blockRange: s.source.blockRange,
      hidden: isHidden(s),
      hiddenByGroup: s.parent !== null && isHiddenInDrawing(s.parent),
    });
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}

/**
 * Hides a visible shape (`display=none`) or shows a hidden one (removes `display`). When a style
 * hides it, showing writes `display=inline`, which wins over the style.
 */
export function toggleHidden(target: PropertyTarget, path: string): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || !canEdit(shape, result)) return result;
  const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
  if (!isHidden(shape)) se.set("display", "none");
  else if (styleHides(target, shape)) se.set("display", "inline");
  else se.remove("display");
  result.edits = normalizeEdits(target.source, se.edits());
  return result;
}

/** One of the shape's styles sets `display=none` (the last style that sets `display` wins). */
function styleHides(target: PropertyTarget, shape: Shape): boolean {
  const style = shape.source.attrs.find((a) => a.name === "style");
  if (!style) return false;
  let hides = false;
  for (const v of style.values) {
    if (v.kind !== "ident") continue;
    const def = target.tree.statements.find((s) => s.kind === "style" && s.name === v.value);
    const d = def?.attrs.find((a) => a.name === "display");
    if (d) hides = d.values.length === 1 && d.values[0].kind === "ident" && d.values[0].value === "none";
  }
  return hides;
}
