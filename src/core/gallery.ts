/**
 * A library opened in ZyxDraw shows its custom shapes in a grid (issue #24). The cells come from
 * `resolve` (one per line of `preview()`, or one with default values); this file places them,
 * once their sizes are known from a first layout.
 */
import type { Scene } from "./layout/layout";
import { POSITION_ATTRS } from "./builtins/catalog";
import type { Model, Shape } from "./resolve/resolve";
import { isHidden, type Layer } from "./edit/visibility";

/** Space between cells, and between a shape and its name. */
export const GALLERY_GAP = 40;
const LABEL_GAP = 8;
/** Width used when the view's width is not known (tests, exports). */
export const GALLERY_WIDTH = 800;

/**
 * Places the cells in rows: as many columns as fit `width` (at least one), each column as wide as
 * the widest cell, each row as tall as its tallest shape. A shape is centered in its column, its
 * name under it. Hidden cells (`display=none` in `preview()`) take no place and lose their name.
 */
export function arrangeGallery(model: Model, sized: Scene, width = GALLERY_WIDTH): void {
  const gallery = model.gallery;
  if (!gallery) return;
  const box = (s: Shape) => sized.placed.get(s.id)?.box ?? { x: 0, y: 0, w: 0, h: 0 };
  const shown = gallery.cells.filter((c) => !isHidden(c.shape));
  for (const c of gallery.cells) if (isHidden(c.shape)) setPosition(c.label, 0, 0, true);

  const cellWidth = Math.max(1, ...shown.map((c) => Math.max(box(c.shape).w, box(c.label).w)));
  const columns = Math.max(1, Math.floor((width + GALLERY_GAP) / (cellWidth + GALLERY_GAP)));
  let top = 0;
  for (let row = 0; row * columns < shown.length; row++) {
    const cells = shown.slice(row * columns, (row + 1) * columns);
    const shapeHeight = Math.max(...cells.map((c) => box(c.shape).h));
    const labelHeight = Math.max(...cells.map((c) => box(c.label).h));
    cells.forEach((c, i) => {
      const left = i * (cellWidth + GALLERY_GAP);
      setPosition(c.shape, left + (cellWidth - box(c.shape).w) / 2, top);
      setPosition(c.label, left + (cellWidth - box(c.label).w) / 2, top + shapeHeight + LABEL_GAP);
    });
    top += shapeHeight + LABEL_GAP + labelHeight + GALLERY_GAP;
  }
}

/** Sets `x` / `y` on a resolved shape, replacing any other position (lines in `preview()` have none). */
function setPosition(s: Shape, x: number, y: number, hide = false): void {
  for (const k of [...s.attrs.keys()]) if (POSITION_ATTRS.has(k)) s.attrs.delete(k);
  const at = (v: number) => ({ value: { t: "len" as const, len: { v, pct: false } }, range: s.stmt.range, written: "x" });
  s.attrs.set("x", at(x));
  s.attrs.set("y", { ...at(y), written: "y" });
  if (hide) s.attrs.set("display", { value: { t: "str", v: "none" }, range: s.stmt.range, written: "display" });
}

/**
 * The eye icons of a library (issue #25): one per custom shape definition, which hides it in the
 * gallery only (path `def:name`, no text change), and one per line of `preview()`, which writes
 * `display=none` there as in a drawing.
 */
export function galleryLayers(scene: Scene): Layer[] {
  const gallery = scene.gallery;
  if (!gallery) return [];
  const out: Layer[] = gallery.defs.map((d) => ({ path: `def:${d.name}`, range: d.range, blockRange: d.blockRange, hidden: d.hidden, hiddenByGroup: false }));
  for (const c of gallery.cells) {
    if (c.shape.preview?.placeholder) continue;
    out.push({ path: c.shape.path, range: c.shape.source.range, blockRange: c.shape.source.blockRange, hidden: isHidden(c.shape), hiddenByGroup: false });
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}
