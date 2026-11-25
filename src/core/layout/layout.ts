import { Code, Diagnostics } from "../diagnostics";
import { pathBounds, pointsBounds, type Bounds } from "../geometry";
import type { Frame, Gallery, GradientDef, Len, Model, RAttr, Shape } from "../resolve/resolve";
import type { SourceRange } from "../syntax/ast";

export interface FontSpec {
  size: number;
  family?: string;
  weight?: string;
  style?: string;
}

/** Measures text. The plugin uses the real font; tests use the approximate measurer. */
export interface TextMeasurer {
  measure(text: string, font: FontSpec): { width: number; height: number };
}

/** Deterministic measure: width = characters x size x 0.6, height = lines x size x 1.2. */
export const approxMeasurer: TextMeasurer = {
  measure(text, font) {
    const lines = text.split("\n");
    const longest = Math.max(...lines.map((l) => l.length));
    return { width: longest * font.size * 0.6, height: lines.length * font.size * 1.2 };
  },
};

export const DEFAULT_FONT_SIZE = 16;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placed {
  /** Bounding box in the parent's coordinates. */
  box: Box;
  /** For lines: end points in the parent's coordinates. */
  line?: { x1: number; y1: number; x2: number; y2: number };
}

export interface Scene {
  frame: Frame;
  roots: Shape[];
  placed: Map<number, Placed>;
  /** For each clipped shape (by id): its clip shapes laid out in the shape's own box. */
  clips: Map<number, Scene>;
  /** Gradients used by the drawing (written to the SVG's defs). */
  gradients?: GradientDef[];
  /** A library opened in ZyxDraw: its shapes in a grid (issue #24). */
  gallery?: Gallery;
}

/** Hard limit on layout steps: a second guard (besides the cycle check) against hanging Obsidian. */
const STEP_LIMIT = 200_000;

type Axis = 0 | 1;

const AXIS = [
  { start: "x", end: "right", center: "cx", after: "right-of", before: "left-of", size: "width", word: "horizontal" },
  { start: "y", end: "bottom", center: "cy", after: "below", before: "above", size: "height", word: "vertical" },
] as const;

type Method =
  | { k: "default" }
  | { k: "start"; len: Len; range: SourceRange }
  | { k: "end"; len: Len; range: SourceRange }
  | { k: "center"; len: Len; range: SourceRange }
  | { k: "stretch"; start: Len; end: Len; range: SourceRange }
  | { k: "after" | "before"; path: string; gap: Len; range: SourceRange };

export function layout(model: Model, diags: Diagnostics, measurer: TextMeasurer = approxMeasurer): Scene {
  const engine = new Engine(model, diags, measurer);
  return engine.run();
}

class Engine {
  private readonly memo = new Map<string, number>();
  private readonly methods = new Map<string, Method>();
  private readonly textSize = new Map<number, { width: number; height: number }>();
  private readonly stack: { key: string; shape: Shape }[] = [];
  private steps = 0;
  private limitHit = false;

  constructor(
    private readonly model: Model,
    private readonly diags: Diagnostics,
    private readonly measurer: TextMeasurer,
  ) {}

  run(): Scene {
    const placed = new Map<number, Placed>();
    const lines: Shape[] = [];
    const visit = (s: Shape) => {
      if (s.spec.boxed) {
        placed.set(s.id, { box: { x: this.pos(s, 0), y: this.pos(s, 1), w: this.size(s, 0), h: this.size(s, 1) } });
      } else {
        lines.push(s);
      }
      s.children.forEach(visit);
    };
    this.model.roots.forEach(visit);
    for (const line of lines) placed.set(line.id, this.placeLine(line));

    // Clips: `%` and positions inside a clip refer to the clipped shape's box.
    const clips = new Map<number, Scene>();
    const visitClips = (s: Shape) => {
      const box = placed.get(s.id)?.box;
      if (s.clip && box) {
        const model: Model = { frame: { x: 0, y: 0, width: box.w, height: box.h }, roots: s.clip.shapes };
        clips.set(s.id, new Engine(model, this.diags, this.measurer).run());
      }
      s.children.forEach(visitClips);
    };
    this.model.roots.forEach(visitClips);
    return { frame: this.model.frame, roots: this.model.roots, placed, clips, gradients: this.model.gradients ?? [], gallery: this.model.gallery };
  }

  // ---- memo + cycle detection ---------------------------------------------------------------

  private evaluate(key: string, shape: Shape, fn: () => number): number {
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;
    if (++this.steps > STEP_LIMIT) {
      if (!this.limitHit) {
        this.limitHit = true;
        this.diags.error(Code.LayoutLimit, "Layout is too complex (step limit reached)", shape.stmt.range);
      }
      return 0;
    }
    const at = this.stack.findIndex((f) => f.key === key);
    if (at !== -1) {
      this.reportCycle([...this.stack.slice(at).map((f) => f.shape), shape]);
      return 0;
    }
    this.stack.push({ key, shape });
    const value = fn();
    this.stack.pop();
    this.memo.set(key, value);
    return value;
  }

  private reportCycle(chain: Shape[]): void {
    const shapes: Shape[] = [];
    for (const s of chain) if (shapes[shapes.length - 1] !== s) shapes.push(s);
    if (shapes.length > 1 && shapes[0] === shapes[shapes.length - 1]) shapes.pop();
    // Start at the earliest shape so the same loop is reported once, whatever the entry point.
    let first = 0;
    shapes.forEach((s, i) => {
      if (s.id < shapes[first].id) first = i;
    });
    const ordered = [...shapes.slice(first), ...shapes.slice(0, first)];
    const names = [...ordered, ordered[0]].map((s) => s.path).join(" -> ");
    const anchor = ["right-of", "left-of", "above", "below"].map((k) => ordered[0].attrs.get(k)).find(Boolean);
    this.diags.error(Code.CircularAnchor, `Circular anchor: ${names}`, anchor?.range ?? ordered[0].stmt.range);
  }

  // ---- positioning method per axis ----------------------------------------------------------

  private method(s: Shape, axis: Axis): Method {
    const key = `${s.id}:${axis}`;
    let m = this.methods.get(key);
    if (!m) {
      m = this.computeMethod(s, axis);
      this.methods.set(key, m);
    }
    return m;
  }

  private computeMethod(s: Shape, axis: Axis): Method {
    const names = AXIS[axis];
    const get = (k: string): RAttr | undefined => s.attrs.get(k);
    const start = get(names.start);
    const end = get(names.end);
    const center = get(names.center);
    const after = get(names.after);
    const before = get(names.before);
    const conflict = (msg: string, at: RAttr): Method => {
      this.diags.error(Code.PositionConflict, msg, at.range);
      return { k: "default" };
    };

    if (after && before) {
      return conflict(`Conflicting anchors: \`${after.written}\` and \`${before.written}\` cannot be used together`, before);
    }
    const anchor = after ?? before;
    const absolute = start ?? end ?? center;
    if (anchor && absolute) {
      return conflict(
        `\`${absolute.written}\` and \`${anchor.written}\` both set the ${names.word} position (absolute and relative)`,
        anchor,
      );
    }
    if (anchor && anchor.value.t === "anchor") {
      return { k: anchor === after ? "after" : "before", path: anchor.value.path, gap: anchor.value.gap, range: anchor.range };
    }
    if (center && (start || end)) {
      return conflict(`\`${(start ?? end)!.written}\` and \`${center.written}\` both set the ${names.word} position`, center);
    }
    if (start && end) {
      const size = get(names.size);
      if (!s.spec.stretchable) {
        return conflict(`\`${start.written}\` with \`${end.written}\` (stretch) is only supported for rect and group`, end);
      }
      if (size) return conflict(`Stretch (\`${start.written}\` + \`${end.written}\`) conflicts with \`${size.written}\``, size);
      return { k: "stretch", start: len(start), end: len(end), range: end.range };
    }
    if (start) return { k: "start", len: len(start), range: start.range };
    if (end) return { k: "end", len: len(end), range: end.range };
    if (center) return { k: "center", len: len(center), range: center.range };
    return { k: "default" };
  }

  // ---- sizes --------------------------------------------------------------------------------

  /** Size of a shape's box on one axis. */
  size(s: Shape, axis: Axis): number {
    return this.evaluate(`size:${s.id}:${axis}`, s, () => this.computeSize(s, axis));
  }

  private computeSize(s: Shape, axis: Axis): number {
    const m = this.method(s, axis);
    if (m.k === "stretch") {
      const base = this.parentSize(s, axis, m.range, "Stretch");
      return Math.max(0, base - this.toPx(m.start, s, axis, m.range) - this.toPx(m.end, s, axis, m.range));
    }
    const attr = (k: string) => {
      const a = s.attrs.get(k);
      return a && a.value.t === "len" ? a : undefined;
    };
    switch (s.type) {
      case "rect":
      case "group": {
        const a = attr(AXIS[axis].size);
        if (a) return this.toPx(len(a), s, axis, a.range);
        if (s.type === "rect") return 0;
        // A layer without a size covers the canvas.
        if (s.layer && !this.model.frame.infinite) return axis === 0 ? this.model.frame.width : this.model.frame.height;
        // Group without a size: bounding box of its children.
        let extent = 0;
        for (const c of s.children) {
          if (!c.spec.boxed) continue;
          extent = Math.max(extent, this.pos(c, axis) + this.size(c, axis));
        }
        return extent;
      }
      case "circle":
        return 2 * this.px(s, "r");
      case "ellipse": {
        const rx = this.px(s, "rx");
        return 2 * (axis === 0 ? rx : s.attrs.has("ry") ? this.px(s, "ry") : rx);
      }
      case "text": {
        const t = this.measureText(s);
        return axis === 0 ? t.width : t.height;
      }
      case "polyline":
      case "polygon":
      case "path": {
        const b = this.bounds(s);
        if (!Number.isFinite(b.minX)) return 0;
        return axis === 0 ? b.maxX - b.minX : b.maxY - b.minY;
      }
      case "line":
        return 0;
    }
  }

  /** Size of the parent, for percent and edge offsets. Errors if the parent has no known size. */
  private parentSize(s: Shape, axis: Axis, range: SourceRange, what: string): number {
    const p = s.parent;
    if (!p && this.model.frame.infinite) {
      this.diags.error(
        Code.PercentNeedsSize,
        `${what} needs a canvas size, and \`canvas(infinite)\` has none: use pixels, put the shape in a group with a \`${AXIS[axis].size}\`, or give the canvas a width and height`,
        range,
      );
      return 0;
    }
    if (!p) return axis === 0 ? this.model.frame.width : this.model.frame.height;
    const known = p.attrs.has(AXIS[axis].size) || this.method(p, axis).k === "stretch" || (!!p.layer && !this.model.frame.infinite);
    if (!known) {
      this.diags.error(
        Code.PercentNeedsSize,
        `${what} needs a parent with a known size: give \`${p.path}\` a \`${AXIS[axis].size}\``,
        range,
      );
      return 0;
    }
    return this.size(p, axis);
  }

  private toPx(l: Len, s: Shape, axis: Axis, range: SourceRange): number {
    return l.pct ? (l.v / 100) * this.parentSize(s, axis, range, "Percent") : l.v;
  }

  private px(s: Shape, key: string): number {
    const a = s.attrs.get(key);
    return a && a.value.t === "len" ? a.value.len.v : 0;
  }

  private measureText(s: Shape): { width: number; height: number } {
    let t = this.textSize.get(s.id);
    if (!t) {
      const str = (k: string) => {
        const a = s.attrs.get(k);
        return a && a.value.t === "str" ? a.value.v : undefined;
      };
      const sizeAttr = s.attrs.get("font-size");
      const size = sizeAttr && sizeAttr.value.t === "len" ? sizeAttr.value.len.v : DEFAULT_FONT_SIZE;
      t = this.measurer.measure(s.text ?? "", { size, family: str("font-family"), weight: str("font-weight"), style: str("font-style") });
      this.textSize.set(s.id, t);
    }
    return t;
  }

  private bounds(s: Shape): Bounds {
    if (s.points) return pointsBounds(s.points);
    if (s.pathData) return pathBounds(s.pathData);
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  // ---- positions ----------------------------------------------------------------------------

  /** Left (or top) of a shape's box, in its parent's coordinates. */
  pos(s: Shape, axis: Axis): number {
    return this.evaluate(`pos:${s.id}:${axis}`, s, () => this.computePos(s, axis));
  }

  /** Left (or top) of a shape's box, in frame coordinates. */
  absPos(s: Shape, axis: Axis): number {
    return this.pos(s, axis) + (s.parent ? this.absPos(s.parent, axis) : 0);
  }

  private computePos(s: Shape, axis: Axis): number {
    const m = this.method(s, axis);
    switch (m.k) {
      case "default":
        return this.fromAnchorPoint(s, axis, 0);
      case "start":
      case "stretch": {
        const l = m.k === "start" ? m.len : m.start;
        return this.fromAnchorPoint(s, axis, this.toPx(l, s, axis, m.range));
      }
      case "end": {
        const base = this.parentSize(s, axis, m.range, `\`${AXIS[axis].end}\``);
        return base - this.toPx(m.len, s, axis, m.range) - this.size(s, axis);
      }
      case "center":
        return this.toPx(m.len, s, axis, m.range) - this.size(s, axis) / 2;
      case "after":
      case "before": {
        const target = this.lookup(s, m.path, m.range);
        if (!target) return 0;
        const parentAbs = s.parent ? this.absPos(s.parent, axis) : 0;
        const gap = this.toPx(m.gap, s, axis, m.range);
        const tStart = this.absPos(target, axis);
        if (m.k === "after") return tStart + this.size(target, axis) + gap - parentAbs;
        return tStart - gap - this.size(s, axis) - parentAbs;
      }
    }
  }

  /**
   * Converts an `x` / `y` value to the box start:
   *   - text: `x` is the anchor point (start, middle or end of the text, like SVG)
   *   - polyline, polygon, path: `x` / `y` move the points, so the box starts at x + smallest point
   */
  private fromAnchorPoint(s: Shape, axis: Axis, value: number): number {
    if (s.type === "text" && axis === 0) {
      const a = s.attrs.get("text-anchor");
      const k = a && a.value.t === "str" ? (a.value.v === "middle" ? 0.5 : a.value.v === "end" ? 1 : 0) : 0;
      return value - k * this.size(s, 0);
    }
    if (s.points || s.pathData) {
      const b = this.bounds(s);
      if (Number.isFinite(b.minX)) return value + (axis === 0 ? b.minX : b.minY);
    }
    return value;
  }

  /**
   * Finds a shape by name: siblings first, then outer scopes. `a.b` walks into groups.
   * Inside a custom shape's body, the search stops at the instance (the body cannot see out).
   * Inner parts of an imported custom shape are private.
   */
  private lookup(from: Shape, path: string, range: SourceRange): Shape | null {
    const [head, ...rest] = path.split(".");
    let scope: Shape | null = from.parent;
    let found: Shape | undefined;
    for (;;) {
      const list = scope ? scope.children : this.model.roots;
      found = list.find((c) => c.name === head);
      if (found || !scope || scope.instanceOf) break;
      scope = scope.parent;
    }
    for (const part of rest) {
      if (!found) break;
      if (found.sealed) {
        this.diags.error(Code.PrivatePart, `\`${found.path}\` is an imported \`${found.instanceOf}\`: its inner parts are private`, range);
        return null;
      }
      found = found.children.find((c) => c.name === part);
    }
    if (!found) {
      this.diags.error(Code.UnknownShape, `Unknown shape \`${path}\``, range);
      return null;
    }
    if (found.type === "line") {
      this.diags.error(Code.AnchorToLine, `Cannot anchor to a line (\`${path}\`)`, range);
      return null;
    }
    return found;
  }

  // ---- lines --------------------------------------------------------------------------------

  private placeLine(line: Shape): Placed {
    const origin = { x: line.parent ? this.absPos(line.parent, 0) : 0, y: line.parent ? this.absPos(line.parent, 1) : 0 };

    type End = { x: number; y: number; target?: Shape; box?: Box };
    const end = (ref: "from" | "to", xk: string, yk: string): End => {
      const r = line.attrs.get(ref);
      if (r && r.value.t === "ref") {
        const target = this.lookup(line, r.value.path, r.range);
        if (target) {
          const box = {
            x: this.absPos(target, 0),
            y: this.absPos(target, 1),
            w: this.size(target, 0),
            h: this.size(target, 1),
          };
          return { x: box.x + box.w / 2, y: box.y + box.h / 2, target, box };
        }
      }
      const coord = (k: string, axis: Axis) => {
        const a = line.attrs.get(k);
        return a && a.value.t === "len" ? this.toPx(a.value.len, line, axis, a.range) : 0;
      };
      return { x: coord(xk, 0) + origin.x, y: coord(yk, 1) + origin.y };
    };

    const a = end("from", "x1", "y1");
    const b = end("to", "x2", "y2");
    const pa = clip(a, b);
    const pb = clip(b, a);
    return {
      box: { x: Math.min(pa.x, pb.x) - origin.x, y: Math.min(pa.y, pb.y) - origin.y, w: Math.abs(pa.x - pb.x), h: Math.abs(pa.y - pb.y) },
      line: { x1: pa.x - origin.x, y1: pa.y - origin.y, x2: pb.x - origin.x, y2: pb.y - origin.y },
    };

    /** Moves an end that is attached to a shape from its center to its border, toward `other`. */
    function clip(p: End, other: End): { x: number; y: number } {
      if (!p.target || !p.box) return { x: p.x, y: p.y };
      const dx = other.x - p.x;
      const dy = other.y - p.y;
      if (dx === 0 && dy === 0) return { x: p.x, y: p.y };
      const hw = p.box.w / 2;
      const hh = p.box.h / 2;
      let t: number;
      if (p.target.type === "circle" || p.target.type === "ellipse") {
        t = hw > 0 && hh > 0 ? 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2) : 0;
      } else {
        t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
      }
      t = Math.min(t, 1);
      return { x: p.x + dx * t, y: p.y + dy * t };
    }
  }
}

function len(a: RAttr): Len {
  return a.value.t === "len" ? a.value.len : { v: 0, pct: false };
}
