/**
 * `rotate` and `scale`: drawn as an SVG transform around the center of the shape's box.
 * Layout ignores them (like CSS transforms): anchors and percent use the unturned box.
 */
import type { Shape } from "./resolve/resolve";

export interface ShapeTransform {
  /** Degrees, clockwise. */
  rotate: number;
  sx: number;
  sy: number;
}

/** The shape's own rotate / scale, or null when it has none (or they change nothing). */
export function shapeTransform(s: Shape): ShapeTransform | null {
  const r = s.attrs.get("rotate");
  const sc = s.attrs.get("scale");
  const rotate = r && r.value.t === "num" ? r.value.v : 0;
  let sx = 1;
  let sy = 1;
  if (sc && sc.value.t === "str") {
    const nums = sc.value.v.split(" ").map(Number);
    sx = nums[0];
    sy = nums.length > 1 ? nums[1] : nums[0];
  }
  if (rotate % 360 === 0 && sx === 1 && sy === 1) return null;
  return { rotate, sx, sy };
}

/** SVG `transform` value applying `t` around (cx, cy). */
export function transformAbout(t: ShapeTransform, cx: number, cy: number, fmt: (n: number) => string): string {
  const parts: string[] = [];
  const scaled = t.sx !== 1 || t.sy !== 1;
  if (!scaled) return `rotate(${fmt(t.rotate)} ${fmt(cx)} ${fmt(cy)})`;
  parts.push(`translate(${fmt(cx)} ${fmt(cy)})`);
  if (t.rotate % 360 !== 0) parts.push(`rotate(${fmt(t.rotate)})`);
  parts.push(t.sx === t.sy ? `scale(${fmt(t.sx)})` : `scale(${fmt(t.sx)} ${fmt(t.sy)})`);
  parts.push(`translate(${fmt(-cx)} ${fmt(-cy)})`);
  return parts.join(" ");
}
