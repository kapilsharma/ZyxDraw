/**
 * Point editing for `path` (`d`), `polygon` and `polyline` (`points`): the points a user can
 * drag on the drawing, and the text edits for dragging one. Only the numbers of the dragged
 * point change (plus the next relative command, so the rest of the path stays in place).
 */
import { formatPath, formatPoints, offsetPath, parsePath, parsePoints, pathBounds, pointsBounds, roundedPointsPath } from "../geometry";
import type { Scene } from "../layout/layout";
import type { Shape } from "../resolve/resolve";
import type { SourceRange } from "../syntax/ast";
import { shapeTransform, transformAbout } from "../transform";
import { appendLine, blank, canEdit, editableShape, geometry, moveLineEnd, newShapeName, normalizeEdits, StatementEditor, type EditResult, type EditTarget, type TextEdit } from "./edit";
import { bendPathSide, continuePathText, deletePathNode, isEditablePath, openPathEnds, pathNodeKind, pathSideCurves, pathSides, pathSteps, penPathData, roundPen, setPathNodeSmooth, splitPathSide, type PathStep, type PenNode, type Pt } from "./path-nodes";

export interface PointHandle {
  /** Position in frame coordinates, before rotate / scale (see `overlayTransforms`). */
  x: number;
  y: number;
  /** An end point (on the outline) or a curve's control point. */
  kind: "end" | "control";
  /** Points a control point is drawn connected to (frame coordinates). */
  guides: { x: number; y: number }[];
}

/** A number inside the attribute's text, with its offset in that text. */
interface NumToken {
  value: number;
  start: number;
  end: number;
  text: string;
}

/** One command with exactly one set of arguments (`L 1 2 3 4` is two segments). */
interface Segment {
  upper: string;
  rel: boolean;
  args: NumToken[];
}

/**
 * Which numbers a handle moves: index into the segment list, argument index, axis; `sign` -1
 * moves the number the other way (an `S` or `T` curve's mirrored handle moves the handle it
 * mirrors).
 */
interface Target {
  seg: number;
  arg: number;
  axis: 0 | 1;
  sign?: 1 | -1;
}

interface RawHandle {
  x: number;
  y: number;
  kind: "end" | "control";
  guides: { x: number; y: number }[];
  targets: Target[];
  /** The numbers shown in the text when this point is clicked (default: `targets`). */
  shown?: Target[];
  /** Ends a segment: a following relative command must be corrected. */
  seg: number;
  isEnd: boolean;
  /** End point: the curve handles that move with it. */
  carry?: Target[];
  /**
   * Control point of a smooth node (its handles in a straight line): the node and the other
   * handle, which turns to stay opposite (unless dragged freely).
   */
  partner?: { node: { x: number; y: number }; at: { x: number; y: number }; targets: Target[] };
}

/** Options for dragging a point. */
export interface PointDragOptions {
  /** Drag freely: smooth points may get a corner (default false: they stay smooth). */
  free?: boolean;
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Shapes whose points can be dragged (a line: its two ends, unless it connects shapes). */
export function hasPoints(shape: Shape): boolean {
  if (shape.generated || shape.instanceOf) return false;
  // Points written as calculations (`(width - 10)`) are kept: dragging would replace them.
  const geometry = shape.attrs.get(shape.type === "path" ? "d" : "points");
  if (geometry?.value.t === "str" && geometry.value.v.includes("(")) return false;
  if (shape.type === "line") return !shape.attrs.has("from") && !shape.attrs.has("to");
  return shape.type === "path" || shape.type === "polygon" || shape.type === "polyline";
}

/** The draggable points of the selected shape, or null if it has none (or they come from elsewhere). */
export function pointHandles(scene: Scene, shape: Shape): PointHandle[] | null {
  if (shape.type === "line") return lineHandles(scene, shape);
  const parsed = rawHandles(shape);
  const g = geometry(scene, shape);
  if (!parsed || !g) return null;
  const { handles } = parsed;
  const off = offset(shape, g.box);
  const at = (p: { x: number; y: number }) => ({ x: p.x + off.x, y: p.y + off.y });
  return handles.map((h) => ({ ...at(h), kind: h.kind, guides: h.guides.map(at) }));
}

/** The two ends of a line placed with `x1` / `y1` / `x2` / `y2` (frame coordinates). */
function lineHandles(scene: Scene, shape: Shape): PointHandle[] | null {
  const l = scene.placed.get(shape.id)?.line;
  const g = geometry(scene, shape);
  if (!l || !g || !hasPoints(shape)) return null;
  return [
    { x: l.x1 + g.origin.x, y: l.y1 + g.origin.y, kind: "end", guides: [] },
    { x: l.x2 + g.origin.x, y: l.y2 + g.origin.y, kind: "end", guides: [] },
  ];
}

/**
 * Where point `index`'s numbers are in the source text (from its first number to its last,
 * e.g. `34,95`), so the text can show it. The whole quoted text when it has escapes, and null
 * when the points are not written as text in quotes in the user's file.
 */
export function pointSourceRange(target: EditTarget, path: string, index: number): SourceRange | null {
  const shape = editableShape(target.scene, path);
  if (!shape || shape.path !== path || !hasPoints(shape)) return null;
  if (shape.type === "line") {
    // From `x1=` to `y1=` (or `x2` / `y2`), when both are written.
    const se = new StatementEditor(target.source, shape.source, shape.spec.aliases);
    const attrs = index === 0 ? [se.find("x1"), se.find("y1")] : index === 1 ? [se.find("x2"), se.find("y2")] : [];
    if (attrs.length !== 2 || !attrs[0] || !attrs[1]) return null;
    return { start: Math.min(attrs[0].range.start, attrs[1].range.start), end: Math.max(attrs[0].range.end, attrs[1].range.end) };
  }
  const literal = pointsLiteral(target, shape);
  const parsed = rawHandles(shape);
  const h = parsed?.handles[index];
  if (!literal || !parsed || !h) return null;
  const tokens = (h.shown ?? h.targets).map((t) => parsed.segments[t.seg].args[t.arg]).filter((t): t is NumToken => t !== undefined);
  if (tokens.length === 0) return null;
  const raw = target.source.slice(literal.range.start + 1, literal.range.end - 1);
  if (raw !== String(literal.value)) return { start: literal.range.start, end: literal.range.end };
  const at = literal.range.start + 1;
  return { start: at + Math.min(...tokens.map((t) => t.start)), end: at + Math.max(...tokens.map((t) => t.end)) };
}

// ---- polygon and polyline: new shapes, adding and deleting points ----------------------------

/** Formats a coordinate for the text (the caller picks the precision, e.g. from the zoom). */
export type NumberFormat = (n: number) => string;

/** Adds a new top-level polygon through `points` (frame coordinates), at the end of the file. */
export function insertPolygon(target: EditTarget, points: { x: number; y: number }[], fmt: NumberFormat): EditResult {
  const result = blank();
  if (points.length < 3) {
    result.notices.push("A polygon needs at least 3 points");
    return result;
  }
  const name = newShapeName(target, "polygon");
  const text = points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");
  result.edits = [appendLine(target.source, `${name} is polygon(points="${text}")`)];
  result.select = name;
  return result;
}

/** Adds a new top-level line from `a` to `b` (frame coordinates), at the end of the file. */
export function insertLine(target: EditTarget, a: { x: number; y: number }, b: { x: number; y: number }, fmt: NumberFormat): EditResult {
  const name = newShapeName(target, "line");
  return {
    edits: [appendLine(target.source, `${name} is line(x1=${fmt(a.x)}, y1=${fmt(a.y)}, x2=${fmt(b.x)}, y2=${fmt(b.y)})`)],
    notices: [],
    select: name,
  };
}

/**
 * Adds a new top-level path through pen nodes (frame coordinates), at the end of the file. An
 * open path gets `fill=none` and a stroke, so it shows as a line.
 */
export function insertPath(target: EditTarget, nodes: PenNode[], closed: boolean, fmt: NumberFormat): EditResult {
  const result = blank();
  if (nodes.length < 2) {
    result.notices.push("A path needs at least 2 points");
    return result;
  }
  const round = (p: { x: number; y: number }) => ({ x: Number(fmt(p.x)), y: Number(fmt(p.y)) });
  const rounded = roundPen(nodes, round);
  const name = newShapeName(target, "path");
  const style = closed ? "" : ", fill=none, stroke=black";
  result.edits = [appendLine(target.source, `${name} is path(d="${penPathData(rounded, closed)}"${style})`)];
  result.select = name;
  return result;
}

// ---- continuing an open path or polyline (issue #34) -----------------------------------------

/** An end of an open path or polyline: where it is (frame coordinates) and its point's index. */
export interface OpenEnd {
  at: "start" | "end";
  x: number;
  y: number;
  /** Index in `pointHandles`. */
  point: number;
}

/**
 * The two ends of an open path or polyline, where drawing can go on; null when it cannot be
 * continued: closed paths and polygons, paths with several parts or with commands other than
 * absolute M, L, H, V, C, and shapes turned or scaled (the mouse and the shape's numbers would
 * not line up).
 */
export function openEnds(scene: Scene, shape: Shape): OpenEnd[] | null {
  if (!canAddPoints(shape) || shape.type === "polygon") return null;
  if (shape.type === "path") {
    const d = shape.attrs.get("d");
    if (d?.value.t !== "str" || !openPathEnds(d.value.v)) return null;
  }
  const t = overlayTransforms(scene, shape);
  if (t.parent || t.own) return null;
  const points = pointHandles(scene, shape);
  if (!points) return null;
  const ends = points.map((p, i) => (p.kind === "end" ? i : -1)).filter((i) => i >= 0);
  if (ends.length < 2) return null;
  const first = ends[0];
  const last = ends[ends.length - 1];
  return [
    { at: "start", x: points[first].x, y: points[first].y, point: first },
    { at: "end", x: points[last].x, y: points[last].y, point: last },
  ];
}

/**
 * Continues an open path or polyline from one of its ends (issue #34). `nodes` are pen nodes in
 * frame coordinates: the first is the end drawing goes on from (its `out` handle, if dragged,
 * curves the first new side), then the new points. Only the new part is written: added at the end
 * of `d` / `points`, or at the start, where the new points come first and the old `M` point
 * becomes a line or curve to them. `close`: the last new point is joined to the other end (`Z`);
 * a polyline cannot be closed.
 */
export function continuePath(target: EditTarget, path: string, at: "start" | "end", nodes: PenNode[], close: boolean, fmt: NumberFormat): EditResult {
  if (nodes.length < 2) {
    const result = blank();
    result.notices.push("Place at least one new point to continue the path");
    return result;
  }
  const result = editPoints(target, path, (shape, value) => {
    // The shape's place on the drawing (inside its groups), as for its point handles.
    const g = geometry(target.scene, shape);
    if (!g || !openEnds(target.scene, shape)) return "only open paths and polylines that are not turned or scaled can be continued";
    const off = offset(shape, g.box);
    const own = (p: Pt): Pt => ({ x: Number(fmt(p.x - off.x)), y: Number(fmt(p.y - off.y)) });
    const local: PenNode[] = roundPen(nodes, own);
    if (shape.type === "polyline") {
      if (close) return "a polyline cannot be closed: change `polyline` to `polygon` to close it";
      return polylineContinue(value, at, local.slice(1), fmt);
    }
    const d = continuePathText(value, at, local, close);
    return typeof d === "string" ? changed(value, d) : d.error;
  });
  if (result.edits.length > 0) result.select = path;
  return result;
}

/** New points for a polyline's `points`, at its start or end, with the separators it already uses. */
function polylineContinue(value: string, at: "start" | "end", added: Pt[], fmt: NumberFormat): { start: number; end: number; insert: string } | string {
  const t = numbers(value);
  if (t.length < 4 || t.length % 2 !== 0) return "the points of this polyline cannot be read";
  const within = value.slice(t[0].end, t[1].start) || ",";
  const between = value.slice(t[1].end, t[2].start) || " ";
  const one = (p: Pt) => `${fmt(p.x)}${within}${fmt(p.y)}`;
  if (at === "end") {
    const after = t[t.length - 1].end;
    return { start: after, end: after, insert: added.map((p) => between + one(p)).join("") };
  }
  const before = t[0].start;
  return { start: before, end: before, insert: [...added].reverse().map((p) => one(p) + between).join("") };
}

/** Shapes that can get and lose points: polygon, polyline, and paths of lines and curves. */
export function canAddPoints(shape: Shape): boolean {
  if (!hasPoints(shape)) return false;
  if (shape.type === "polygon" || shape.type === "polyline") return true;
  const d = shape.attrs.get("d");
  return shape.type === "path" && d?.value.t === "str" && isEditablePath(d.value.v);
}

/**
 * The middle of each side of a polygon / polyline / path (frame coordinates, before rotate /
 * scale), where a point can be added. Index = side. On a curve, the middle is on the curve.
 */
export function sideHandles(scene: Scene, shape: Shape): { x: number; y: number }[] | null {
  if (!canAddPoints(shape)) return null;
  const g = geometry(scene, shape);
  if (!g) return null;
  const off = offset(shape, g.box);
  if (shape.type === "path") {
    const d = shape.attrs.get("d");
    const sides = d?.value.t === "str" ? pathSides(d.value.v) : null;
    return sides?.map((p) => ({ x: p.x + off.x, y: p.y + off.y })) ?? null;
  }
  const points = pointHandles(scene, shape);
  if (!points) return null;
  const n = shape.type === "polygon" ? points.length : points.length - 1;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return out;
}

/**
 * Adds a point on side `side` (between point `side` and the next one; for a polygon the last
 * side closes the shape): at the side's middle, moved by (dx, dy). The result's `point` is the
 * new point's index (for a polygon `side + 1`). On a path curve, the curve is split in two.
 */
export function insertPoint(target: EditTarget, path: string, side: number, dx: number, dy: number, fmt: NumberFormat): EditResult {
  let point: number | undefined;
  const result = editPoints(target, path, (shape, value) => {
    if (shape.type !== "path") {
      point = side + 1;
      return pointsInsert(value, side, shape.type === "polygon", dx, dy, fmt);
    }
    const split = splitPathSide(value, side, dx, dy, (n) => Number(fmt(n)));
    if (typeof split === "string") return split;
    point = endHandleIndex(split.d, split.node);
    return changed(value, split.d);
  });
  if (result.edits.length > 0) result.point = point;
  return result;
}

/** The handle index of path node `node` (its `node`-th end point) in path text `d`. */
function endHandleIndex(d: string, node: number): number | undefined {
  const segments = pathSegments(d);
  if (!segments) return undefined;
  const ends = pathHandles(segments)
    .map((h, i) => (h.kind === "end" ? i : -1))
    .filter((i) => i >= 0);
  return ends[node];
}

/** The `points` / `d` text after `insertPoint`, for a live preview while dragging. */
export function insertedPointsText(shape: Shape, side: number, dx: number, dy: number, fmt: NumberFormat): string | null {
  const a = shape.attrs.get(shape.type === "path" ? "d" : "points");
  if (!canAddPoints(shape) || !a || a.value.t !== "str") return null;
  if (shape.type === "path") {
    const split = splitPathSide(a.value.v, side, dx, dy, (n) => Number(fmt(n)));
    return typeof split === "string" ? null : split.d;
  }
  const change = pointsInsert(a.value.v, side, shape.type === "polygon", dx, dy, fmt);
  return typeof change === "string" ? null : a.value.v.slice(0, change.start) + change.insert + a.value.v.slice(change.end);
}

/** Removes point `index`. A polygon keeps at least 3 points, a polyline and a path 2. */
export function deletePoint(target: EditTarget, path: string, index: number): EditResult {
  return editPoints(target, path, (shape, value) => {
    if (shape.type === "path") {
      const parsed = rawHandles(shape);
      const h = parsed?.handles[index];
      if (!parsed || !h) return "this point cannot be found in `d`";
      if (h.kind !== "end") return "this is a curve handle: select a point on the outline to delete it";
      const node = parsed.handles.slice(0, index).filter((x) => x.kind === "end").length;
      const d = deletePathNode(value, node);
      return typeof d === "string" ? changed(value, d) : d.error;
    }
    const t = numbers(value);
    const n = t.length / 2;
    const min = shape.type === "polygon" ? 3 : 2;
    if (!Number.isInteger(n) || index < 0 || index >= n) return "this point cannot be found in `points`";
    if (n <= min) return `a ${shape.type} needs at least ${min} points, so this one cannot be deleted`;
    // Take the point with the space after it (or, for the last point, the space before it).
    return index < n - 1
      ? { start: t[2 * index].start, end: t[2 * index + 2].start, insert: "" }
      : { start: t[2 * index - 1].end, end: t[2 * index + 1].end, insert: "" };
  });
}

/** Where to add a point on `side` of the `points` text, or a reason it cannot be added. */
function pointsInsert(value: string, side: number, closed: boolean, dx: number, dy: number, fmt: NumberFormat): { start: number; end: number; insert: string } | string {
  const t = numbers(value);
  const n = t.length / 2;
  const sides = closed ? n : n - 1;
  if (!Number.isInteger(n) || n < 2 || side < 0 || side >= sides) return "this side cannot be found in `points`";
  const next = (side + 1) % n;
  const x = (t[2 * side].value + t[2 * next].value) / 2 + dx;
  const y = (t[2 * side + 1].value + t[2 * next + 1].value) / 2 + dy;
  // Same separators as the text already uses: within a point (`10,20`) and between points.
  const within = value.slice(t[0].end, t[1].start) || ",";
  const between = n > 1 ? value.slice(t[1].end, t[2].start) || " " : " ";
  const at = t[2 * side + 1].end;
  return { start: at, end: at, insert: `${between}${fmt(x)}${within}${fmt(y)}` };
}

// ---- bending sides and corner / smooth points (issue #35) -------------------------------------

/**
 * The sides of a selected path that can be bent by dragging them, as path text in the path's
 * own numbers (null for an arc), and where those numbers are drawn (`offset`, frame
 * coordinates before rotate / scale). Null for other shapes.
 */
export function bendableSides(scene: Scene, shape: Shape): { curves: (string | null)[]; offset: { x: number; y: number } } | null {
  if (shape.type !== "path" || !canAddPoints(shape)) return null;
  const d = shape.attrs.get("d");
  const g = geometry(scene, shape);
  const curves = d?.value.t === "str" ? pathSideCurves(d.value.v) : null;
  return curves && g ? { curves, offset: offset(shape, g.box) } : null;
}

/**
 * Bends side `side` of a path (issue #35): the spot `grab` (frame coordinates, before rotate /
 * scale) moves by (dx, dy) and the side becomes a curve through it.
 */
export function bendSide(target: EditTarget, path: string, side: number, grab: { x: number; y: number }, dx: number, dy: number, fmt: NumberFormat): EditResult {
  return editPoints(target, path, (shape, value) => {
    if (shape.type !== "path") return "only the sides of a path can be bent";
    const g = geometry(target.scene, shape);
    if (!g) return "this path is not drawn";
    const off = offset(shape, g.box);
    const d = bendPathSide(value, side, { x: grab.x - off.x, y: grab.y - off.y }, dx, dy, (n) => Number(fmt(n)));
    return typeof d === "string" ? changed(value, d) : d.error;
  });
}

/** The `d` text after `bendSide`, for a live preview while dragging; null if the side cannot be bent. */
export function bentPointsText(scene: Scene, shape: Shape, side: number, grab: { x: number; y: number }, dx: number, dy: number, fmt: NumberFormat): string | null {
  const sides = bendableSides(scene, shape);
  const d = shape.attrs.get("d");
  if (!sides || d?.value.t !== "str") return null;
  const out = bendPathSide(d.value.v, side, { x: grab.x - sides.offset.x, y: grab.y - sides.offset.y }, dx, dy, (n) => Number(fmt(n)));
  return typeof out === "string" ? out : null;
}

/** The node (point on the outline) of handle `index` of a path, or null for a curve handle. */
function nodeOf(shape: Shape, index: number): number | null {
  const parsed = rawHandles(shape);
  const h = parsed?.handles[index];
  if (!parsed || !h || h.kind !== "end") return null;
  return parsed.handles.slice(0, index).filter((x) => x.kind === "end").length;
}

/**
 * Whether point `index` of a path is smooth or a corner (issue #35); null when it cannot be
 * switched (not a path, a curve handle, an end of an open path, next to an arc).
 */
export function pointKind(shape: Shape, index: number): "smooth" | "corner" | null {
  if (shape.type !== "path" || !canAddPoints(shape)) return null;
  const d = shape.attrs.get("d");
  const node = nodeOf(shape, index);
  return node === null || d?.value.t !== "str" ? null : pathNodeKind(d.value.v, node);
}

/** Makes point `index` of a path smooth or a corner (issue #35). */
export function setPointSmooth(target: EditTarget, path: string, index: number, smooth: boolean, fmt: NumberFormat): EditResult {
  return editPoints(target, path, (shape, value) => {
    const node = shape.type === "path" ? nodeOf(shape, index) : null;
    if (node === null) return "only points on the outline of a path can be made smooth or a corner";
    const d = setPathNodeSmooth(value, node, smooth, (n) => Number(fmt(n)));
    return typeof d === "string" ? changed(value, d) : d.error;
  });
}

// ---- a path's steps in plain words (issue #40) -------------------------------------------------

/** The steps of a path's `d` in plain words, and where its own numbers are drawn; null for other shapes. */
export function stepsOf(scene: Scene, shape: Shape): { steps: PathStep[]; offset: { x: number; y: number } } | null {
  const d = shape.attrs.get("d");
  const g = geometry(scene, shape);
  if (shape.type !== "path" || d?.value.t !== "str" || !g || !shape.pathData) return null;
  const steps = pathSteps(d.value.v);
  return steps ? { steps, offset: offset(shape, g.box) } : null;
}

/**
 * The path whose `d` is at text position `pos` (on the attribute's name or its text), with its
 * steps: for the hover in the left panel. Null elsewhere.
 */
export function stepsAt(target: EditTarget, pos: number): { path: string; steps: PathStep[] } | null {
  for (const shape of allShapesOf(target.scene)) {
    if (shape.type !== "path" || shape.generated || shape.instanceOf) continue;
    if (pos < shape.source.range.start || pos > shape.source.range.end) continue;
    const attr = new StatementEditor(target.source, shape.source, shape.spec.aliases).find("d");
    if (!attr || pos < attr.range.start || pos > attr.range.end) continue;
    const found = stepsOf(target.scene, shape);
    if (found) return { path: shape.path, steps: found.steps };
  }
  return null;
}

/** Every shape of the scene, nested ones too. */
function allShapesOf(scene: Scene): Shape[] {
  const out: Shape[] = [];
  const walk = (list: Shape[]) => {
    for (const s of list) {
      out.push(s);
      walk(s.children ?? []);
    }
  };
  walk(scene.roots);
  return out;
}

/**
 * Changes number `index` of a path's `d` (counting every number in its steps) to `text`: only
 * that number changes in the text (issue #40).
 */
export function setPathNumber(target: EditTarget, path: string, index: number, text: string): EditResult {
  return editPoints(target, path, (shape, value) => {
    if (shape.type !== "path") return "only a path has steps";
    const n = pathSteps(value)?.flatMap((s) => s.numbers)[index];
    if (!n) return "this number cannot be found in `d`";
    const t = text.trim();
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(t)) return `\`${t}\` is not a number`;
    if (n.label.includes("(1)") && t !== "0" && t !== "1") return `${n.label}: write 1 or 0`;
    // A number written straight after another one needs a space before it (`10-5` -> `10 5`).
    const before = value[n.start - 1];
    const space = before !== undefined && /[\d.]/.test(before) ? " " : "";
    return { start: n.start, end: n.end, insert: space + t };
  });
}

/** The smallest change from `before` to `after`: the text both share at the start and end is kept. */
function changed(before: string, after: string): { start: number; end: number; insert: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { start, end: before.length - end, insert: after.slice(start, after.length - end) };
}

/** Changes the `points` text of a polygon / polyline as written in the user's file. */
function editPoints(target: EditTarget, path: string, change: (shape: Shape, value: string) => { start: number; end: number; insert: string } | string): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || shape.path !== path || !canAddPoints(shape) || !canEdit(shape, result)) return result;
  const literal = pointsLiteral(target, shape);
  if (!literal) {
    result.notices.push(`\`${shape.type === "path" ? "d" : "points"}\` of \`${shape.path}\` is not written as text in quotes here, so points cannot be added or deleted`);
    return result;
  }
  const value = String(literal.value);
  const c = change(shape, value);
  if (typeof c === "string") {
    result.notices.push(`\`${shape.path}\`: ${c}`);
    return result;
  }
  const raw = target.source.slice(literal.range.start + 1, literal.range.end - 1);
  result.edits =
    raw === value
      ? [{ from: literal.range.start + 1 + c.start, to: literal.range.start + 1 + c.end, insert: c.insert }]
      : [{ from: literal.range.start, to: literal.range.end, insert: JSON.stringify(value.slice(0, c.start) + c.insert + value.slice(c.end)) }];
  return result;
}

/** The `d` / `points` value as a single quoted text in the user's statement, or null. */
function pointsLiteral(target: EditTarget, shape: Shape) {
  const attr = new StatementEditor(target.source, shape.source, shape.spec.aliases).find(shape.type === "path" ? "d" : "points");
  return attr?.values.length === 1 && attr.values[0].kind === "string" ? attr.values[0] : null;
}

/**
 * Moves point `index` by (dx, dy) (drawing units, before rotate / scale). An end point takes
 * its curve handles along; a handle of a smooth point turns the other one too (unless `free`).
 */
export function movePoint(target: EditTarget, path: string, index: number, dx: number, dy: number, options: PointDragOptions = {}): EditResult {
  const result = blank();
  const shape = editableShape(target.scene, path);
  if (!shape || shape.path !== path || !hasPoints(shape) || !canEdit(shape, result)) return result;
  if (shape.type === "line") return moveLineEnd(target, path, index === 0 ? 0 : 1, dx, dy);
  const name = shape.type === "path" ? "d" : "points";
  const literal = pointsLiteral(target, shape);
  if (!literal) {
    result.notices.push(`\`${name}\` of \`${shape.path}\` is not written as text in quotes here, so its points cannot be dragged`);
    return result;
  }
  const delta = pointDeltas(shape, index, dx, dy, options);
  if (!delta) return result;

  // Offsets inside the string map to the source only when the text has no escapes.
  const raw = target.source.slice(literal.range.start + 1, literal.range.end - 1);
  const value = String(literal.value);
  const edits: TextEdit[] = [];
  if (raw === value) {
    for (const [t, d] of delta) {
      if (d === 0) continue;
      edits.push({ from: literal.range.start + 1 + t.start, to: literal.range.start + 1 + t.end, insert: formatLike(t, t.value + d) });
    }
  } else {
    edits.push({ from: literal.range.start, to: literal.range.end, insert: JSON.stringify(withDeltas(value, delta)) });
  }
  result.edits = normalizeEdits(target.source, edits);
  return result;
}

/**
 * The shape's `d` / `points` text after moving point `index` by (dx, dy), for a live preview
 * while dragging. Null if the point cannot be moved.
 */
export function movedPointsText(shape: Shape, index: number, dx: number, dy: number, options: PointDragOptions = {}): string | null {
  const a = shape.attrs.get(shape.type === "path" ? "d" : "points");
  const delta = pointDeltas(shape, index, dx, dy, options);
  if (!a || a.value.t !== "str" || !delta) return null;
  return withDeltas(a.value.v, delta);
}

/**
 * The drawn element's geometry attribute (`d` or `points`) for new point text, placed where
 * the shape is drawn now. For a live preview while dragging.
 */
export function previewGeometry(scene: Scene, shape: Shape, text: string): { attr: "d" | "points"; value: string } | null {
  const placed = scene.placed.get(shape.id);
  if (!placed) return null;
  const off = offset(shape, placed.box);
  const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
  if (shape.type === "path") {
    const p = parsePath(text);
    return p.ok ? { attr: "d", value: formatPath(offsetPath(p.value, off.x, off.y), fmt) } : null;
  }
  const p = parsePoints(text, 2);
  if (!p.ok) return null;
  const r = shape.attrs.get("radius");
  const radius = r && r.value.t === "len" ? r.value.len.v : 0;
  if (radius) return { attr: "d", value: roundedPointsPath(p.value, shape.type === "polygon", radius, off.x, off.y, fmt) };
  return { attr: "points", value: formatPoints(p.value, off.x, off.y, fmt) };
}

/** How much each number changes when point `index` moves by (dx, dy). */
function pointDeltas(shape: Shape, index: number, dx: number, dy: number, options: PointDragOptions): Map<NumToken, number> | null {
  const parsed = rawHandles(shape);
  const h = parsed?.handles[index];
  if (!parsed || !h) return null;
  const delta = new Map<NumToken, number>();
  const add = (t: NumToken | undefined, d: number) => {
    if (t) delta.set(t, (delta.get(t) ?? 0) + d);
  };
  const move = (targets: Target[], mx: number, my: number) => {
    for (const t of targets) add(parsed.segments[t.seg].args[t.arg], (t.axis === 0 ? mx : my) * (t.sign ?? 1));
  };
  move(h.targets, dx, dy);
  move(h.carry ?? [], dx, dy);
  // A smooth point's other handle turns to stay opposite, keeping its length.
  const p = h.partner;
  if (p && !options.free) {
    const ux = h.x + dx - p.node.x;
    const uy = h.y + dy - p.node.y;
    const len = Math.hypot(ux, uy);
    const keep = Math.hypot(p.at.x - p.node.x, p.at.y - p.node.y);
    if (len > 1e-9) move(p.targets, p.node.x - (ux / len) * keep - p.at.x, p.node.y - (uy / len) * keep - p.at.y);
  }
  // A relative command after a moved end point is measured from it: move it back.
  const next = parsed.segments[h.seg + 1];
  if (h.isEnd && next && next.rel) {
    for (const t of coordinateArgs(next)) add(next.args[t.arg], t.axis === 0 ? -dx : -dy);
  }
  return delta;
}

function withDeltas(text: string, delta: Map<NumToken, number>): string {
  let out = text;
  for (const [t, d] of [...delta].sort((a, b) => b[0].start - a[0].start)) {
    if (d !== 0) out = out.slice(0, t.start) + formatLike(t, t.value + d) + out.slice(t.end);
  }
  return out;
}

/**
 * SVG transforms for drawing on top of a shape: `parent` turns frame coordinates into what
 * the enclosing groups' rotate / scale show, `own` adds the shape's own. Empty when none.
 */
export function overlayTransforms(scene: Scene, shape: Shape): { parent: string; own: string } {
  const about = (s: Shape): string => {
    const t = shapeTransform(s);
    const g = t && geometry(scene, s);
    return t && g ? transformAbout(t, g.box.x + g.box.w / 2, g.box.y + g.box.h / 2, (n) => String(Math.round(n * 1000) / 1000)) : "";
  };
  const chain: string[] = [];
  for (let p = shape.parent; p; p = p.parent) chain.unshift(about(p));
  return { parent: chain.filter(Boolean).join(" "), own: about(shape) };
}

/**
 * Where the shape's own numbers start, in frame coordinates before its rotate / scale: the
 * 0,0 of a path's `d` or a polygon's `points`, or a group's (or custom shape's) corner, which
 * its children are measured from. Null for other shapes.
 */
export function localOrigin(scene: Scene, shape: Shape): { x: number; y: number } | null {
  const g = geometry(scene, shape);
  if (!g) return null;
  if ((shape.type === "path" && shape.pathData) || ((shape.type === "polygon" || shape.type === "polyline") && shape.points)) {
    return offset(shape, g.box);
  }
  return shape.type === "group" ? { x: g.box.x, y: g.box.y } : null;
}

// ---- parsing ----------------------------------------------------------------------------------

/** Where the shape's own coordinates are drawn: frame coordinates = point + offset. */
function offset(shape: Shape, box: { x: number; y: number }): { x: number; y: number } {
  const b = shape.points ? pointsBounds(shape.points) : pathBounds(shape.pathData!);
  return Number.isFinite(b.minX) ? { x: box.x - b.minX, y: box.y - b.minY } : { x: box.x, y: box.y };
}

function numbers(text: string): NumToken[] {
  const out: NumToken[] = [];
  const re = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ value: Number(m[0]), start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

function rawHandles(shape: Shape): { handles: RawHandle[]; segments: Segment[] } | null {
  if (!hasPoints(shape)) return null;
  const a = shape.attrs.get(shape.type === "path" ? "d" : "points");
  if (!a || a.value.t !== "str") return null;
  const text = a.value.v;
  if (shape.type !== "path") {
    const nums = numbers(text);
    const segments: Segment[] = [];
    const handles: RawHandle[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      segments.push({ upper: "L", rel: false, args: [nums[i], nums[i + 1]] });
      const seg = segments.length - 1;
      handles.push({ x: nums[i].value, y: nums[i + 1].value, kind: "end", guides: [], targets: [{ seg, arg: 0, axis: 0 }, { seg, arg: 1, axis: 1 }], seg, isEnd: false });
    }
    return { handles, segments };
  }
  const segments = pathSegments(text);
  if (!segments) return null;
  return { handles: pathHandles(segments), segments };
}

/** Splits path text into segments, keeping each number's offset. */
function pathSegments(text: string): Segment[] | null {
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const segments: Segment[] = [];
  let cmd: string | null = null;
  let pending: NumToken[] = [];
  let first = true;
  const flush = (): boolean => {
    if (!cmd) return pending.length === 0;
    const upper = cmd.toUpperCase();
    const n = ARGS[upper];
    if (n === undefined) return false;
    if (n === 0) {
      segments.push({ upper, rel: cmd !== upper, args: [] });
      return pending.length === 0;
    }
    if (pending.length === 0 || pending.length % n !== 0) return false;
    for (let i = 0; i < pending.length; i += n) {
      // After the first pair, `M` continues as `L` (and `m` as `l`).
      const u = upper === "M" && i > 0 ? "L" : upper;
      segments.push({ upper: u, rel: cmd !== upper, args: pending.slice(i, i + n) });
    }
    return true;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      if (!flush()) return null;
      cmd = m[1];
      pending = [];
      if (first && cmd.toUpperCase() !== "M") return null;
      first = false;
    } else {
      pending.push({ value: Number(m[2]), start: m.index, end: m.index + m[2].length, text: m[2] });
    }
  }
  return flush() ? segments : null;
}

/** The numbers of a segment that are coordinates (for correcting a relative segment). */
function coordinateArgs(s: Segment): Target[] {
  const out: Target[] = [];
  const t = (arg: number, axis: 0 | 1) => out.push({ seg: -1, arg, axis });
  switch (s.upper) {
    case "H":
      t(0, 0);
      break;
    case "V":
      t(0, 1);
      break;
    case "A":
      t(5, 0);
      t(6, 1);
      break;
    case "Z":
      break;
    default:
      for (let i = 0; i < s.args.length; i++) t(i, (i % 2) as 0 | 1);
  }
  return out;
}

/** A curve control point of one segment: where it is, which numbers it is, and its handle. */
interface Ctrl {
  at: { x: number; y: number };
  targets: Target[];
  handle: number;
}

interface SegInfo {
  upper: string;
  end: { x: number; y: number };
  /** First / second control point of a `C` (`S`: the second only). */
  c1?: Ctrl;
  c2?: Ctrl;
  /** The control point of a `Q`, or the mirrored one of a `T` after a `Q` / `T` (issue #39). */
  q?: Ctrl;
  /** The end point's handle (-1 for `Z`). */
  endHandle: number;
}

/** Whether two handles of a node point in opposite directions (a smooth node). */
function opposite(node: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const ux = a.x - node.x;
  const uy = a.y - node.y;
  const vx = b.x - node.x;
  const vy = b.y - node.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-6 || lv < 1e-6) return false;
  return (ux * vx + uy * vy) / (lu * lv) < -0.999;
}

/**
 * The draggable points of a path: end points and curve control points, in text order. An end
 * written on the start point just before `Z` is the same point as the start: one handle.
 */
function pathHandles(segments: Segment[]): RawHandle[] {
  const handles: RawHandle[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const info: SegInfo[] = [];
  /** The segment index of the current subpath's `M`. */
  let subStart = 0;
  /** Closing segment (ends on the start point) -> its subpath's `M` segment. */
  const closingOf = new Map<number, number>();
  segments.forEach((s, seg) => {
    if (s.upper === "Z") {
      const last = info[seg - 1];
      const first = info[subStart];
      if (last && first && seg - 1 !== subStart && last.endHandle === handles.length - 1 && Math.abs(last.end.x - sx) < 1e-9 && Math.abs(last.end.y - sy) < 1e-9) {
        const lh = handles[last.endHandle];
        const fh = handles[first.endHandle];
        fh.shown = fh.targets;
        fh.targets = [...fh.targets, ...lh.targets];
        handles.pop();
        last.endHandle = first.endHandle;
        closingOf.set(seg - 1, subStart);
      }
      info.push({ upper: "Z", end: { x: sx, y: sy }, endHandle: -1 });
      cx = sx;
      cy = sy;
      return;
    }
    if (s.upper === "M") subStart = seg;
    const ox = s.rel ? cx : 0;
    const oy = s.rel ? cy : 0;
    const v = (i: number) => s.args[i].value;
    const pair = (i: number) => ({ x: v(i) + ox, y: v(i + 1) + oy });
    const targets = (i: number): Target[] => [
      { seg, arg: i, axis: 0 },
      { seg, arg: i + 1, axis: 1 },
    ];
    const start = { x: cx, y: cy };
    let end: { x: number; y: number };
    let endTargets: Target[];
    switch (s.upper) {
      case "H":
        end = { x: v(0) + ox, y: cy };
        endTargets = [{ seg, arg: 0, axis: 0 }];
        break;
      case "V":
        end = { x: cx, y: v(0) + oy };
        endTargets = [{ seg, arg: 0, axis: 1 }];
        break;
      case "A":
        end = { x: v(5) + ox, y: v(6) + oy };
        endTargets = [
          { seg, arg: 5, axis: 0 },
          { seg, arg: 6, axis: 1 },
        ];
        break;
      default: {
        const last = s.args.length - 2;
        end = pair(last);
        endTargets = targets(last);
      }
    }
    const control = (i: number, guides: { x: number; y: number }[]): Ctrl => {
      handles.push({ ...pair(i), kind: "control", guides, targets: targets(i), seg, isEnd: false });
      return { at: pair(i), targets: targets(i), handle: handles.length - 1 };
    };
    const si: SegInfo = { upper: s.upper, end, endHandle: -1 };
    if (s.upper === "C") {
      si.c1 = control(0, [start]);
      si.c2 = control(2, [end]);
    } else if (s.upper === "S") {
      // Its first handle has no numbers: it mirrors the curve before's last handle about the
      // start (issue #38). Shown so the point looks smooth; dragging it turns the handle it
      // mirrors the other way, so the point stays smooth by itself.
      const before = info[seg - 1]?.c2;
      if (before && (info[seg - 1].upper === "C" || info[seg - 1].upper === "S")) {
        const at = { x: 2 * start.x - before.at.x, y: 2 * start.y - before.at.y };
        handles.push({ ...at, kind: "control", guides: [start], targets: before.targets.map((t) => ({ ...t, sign: -1 as const })), seg, isEnd: false });
      }
      si.c2 = control(0, [end]);
    } else if (s.upper === "Q") {
      si.q = control(0, [start, end]);
    } else if (s.upper === "T") {
      // Its control point has no numbers: it mirrors the one before about the start (issue
      // #39). Dragging it moves the `Q` it comes from, so every `T` after that `Q` changes.
      const before = info[seg - 1]?.q;
      if (before) {
        const at = { x: 2 * start.x - before.at.x, y: 2 * start.y - before.at.y };
        const flipped = before.targets.map((t) => ({ ...t, sign: t.sign === -1 ? (1 as const) : (-1 as const) }));
        handles.push({ ...at, kind: "control", guides: [start, end], targets: flipped, seg, isEnd: false });
        si.q = { at, targets: flipped, handle: handles.length - 1 };
      }
    }
    handles.push({ ...end, kind: "end", guides: [], targets: endTargets, seg, isEnd: true });
    si.endHandle = handles.length - 1;
    info.push(si);
    cx = end.x;
    cy = end.y;
    if (s.upper === "M") {
      sx = cx;
      sy = cy;
    }
  });

  info.forEach((si, i) => {
    if (si.endHandle < 0) return;
    // An end point takes the handles on both sides of it along.
    const h = handles[si.endHandle];
    const next = info[i + 1];
    const carry = [...(si.c2?.targets ?? []), ...(next?.upper === "C" && next.c1 ? next.c1.targets : [])];
    if (carry.length > 0) h.carry = [...(h.carry ?? []), ...carry];
    // A smooth node: its two handles turn together.
    const sub = closingOf.get(i);
    const out = sub !== undefined ? info[sub + 1] : next;
    const a = si.c2;
    const b = out?.upper === "C" ? out.c1 : undefined;
    if (a && b && opposite(si.end, a.at, b.at)) {
      handles[a.handle].partner = { node: si.end, at: b.at, targets: b.targets };
      handles[b.handle].partner = { node: si.end, at: a.at, targets: a.targets };
    }
  });
  return handles;
}

/** A number written with as many decimals as the one it replaces (at most 3). */
function formatLike(t: NumToken, v: number): string {
  const dot = t.text.replace(/[eE].*$/, "").indexOf(".");
  const decimals = dot === -1 ? 0 : Math.min(3, t.text.replace(/[eE].*$/, "").length - dot - 1);
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? "0" : r.toFixed(decimals);
}
