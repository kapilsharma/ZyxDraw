/**
 * The area a drawing covers, for `canvas(infinite)`: the SVG's viewBox is this plus padding.
 */
import { allShapes, geometry } from "./edit/edit";
import type { Scene } from "./layout/layout";
import type { Shape } from "./resolve/resolve";
import { shapeTransform } from "./transform";

/** Space around the content of an infinite canvas (also covers arrowheads and line labels). */
export const INFINITE_PADDING = 20;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounds of everything drawn, in frame coordinates: every shape's box widened by half its
 * stroke, turned by its own and its groups' rotate / scale. Null when nothing is drawn.
 */
export function contentBounds(scene: Scene): Bounds | null {
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  // Each shape's transform turns around its box center (frame coordinates).
  const centers = new Map<number, { x: number; y: number }>();
  const center = (s: Shape) => {
    let c = centers.get(s.id);
    if (!c) {
      const g = geometry(scene, s);
      c = g ? { x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 } : { x: 0, y: 0 };
      centers.set(s.id, c);
    }
    return c;
  };
  const turn = (s: Shape, p: { x: number; y: number }) => {
    const t = shapeTransform(s);
    if (!t) return p;
    const c = center(s);
    const a = (t.rotate * Math.PI) / 180;
    const dx = (p.x - c.x) * t.sx;
    const dy = (p.y - c.y) * t.sy;
    return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
  };

  for (const s of allShapes(scene)) {
    if (s.type === "group") continue; // groups draw nothing themselves
    const g = geometry(scene, s);
    if (!g) continue;
    const half = strokeHalf(s);
    const { x, y, w, h } = g.box;
    for (const corner of [
      { x: x - half, y: y - half },
      { x: x + w + half, y: y - half },
      { x: x - half, y: y + h + half },
      { x: x + w + half, y: y + h + half },
    ]) {
      let p = corner;
      for (let o: Shape | null = s; o; o = o.parent) p = turn(o, p);
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return Number.isFinite(b.minX) ? b : null;
}

/**
 * `canvas(infinite)`: sets the frame to the content's bounds plus padding (after layout, before
 * rendering). An empty drawing keeps the default size at 0, 0.
 */
export function fitInfiniteFrame(scene: Scene): void {
  const f = scene.frame;
  if (!f.infinite) return;
  const b = contentBounds(scene);
  if (!b) return;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  f.x = round(Math.floor(b.minX) - INFINITE_PADDING);
  f.y = round(Math.floor(b.minY) - INFINITE_PADDING);
  f.width = round(Math.ceil(b.maxX) + INFINITE_PADDING - f.x);
  f.height = round(Math.ceil(b.maxY) + INFINITE_PADDING - f.y);
}

/** Half the stroke width when the shape has a stroke (SVG draws it centered on the outline). */
function strokeHalf(s: Shape): number {
  const stroke = s.attrs.get("stroke");
  const lineLike = s.type === "line" || s.type === "polyline" || s.type === "path";
  if (!lineLike && (!stroke || (stroke.value.t === "str" && stroke.value.v === "none"))) return 0;
  const w = s.attrs.get("stroke-width");
  return (w && w.value.t === "len" ? w.value.len.v : 1) / 2;
}
