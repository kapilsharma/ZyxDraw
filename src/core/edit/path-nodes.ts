/**
 * Paths as nodes and sides, for the pen tool and for adding, deleting and continuing path points.
 *
 * Works on any path written with the SVG commands `M L H V C S Q T A Z`, in upper case
 * (absolute) or lower case (relative) (issue #37). An edit rewrites only the segments it
 * touches, keeping their command's case, so a relative path stays relative. When the segment
 * after an edit would change meaning (an `S` / `T` that mirrors the previous curve's handle, or a
 * relative command measured from a point that moved), it is rewritten so it draws as before.
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * A pen node: the point, and its curve handles (none: a corner). `arc`: the side arriving at
 * this node is a circle arc through that point (issue #39); on the first node, it is the
 * closing side's.
 */
export interface PenNode extends Pt {
  in?: Pt;
  out?: Pt;
  arc?: Pt;
}

const near = (a: Pt, b: Pt, eps = 1e-9) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const shift = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });
const reflect = (p: Pt, about: Pt): Pt => ({ x: 2 * about.x - p.x, y: 2 * about.y - p.y });
const toward = (a: Pt, b: Pt, f: number): Pt => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

/** Numbers written back: as they are, with at most 3 decimals. */
function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

const pt = (p: Pt) => `${num(p.x)},${num(p.y)}`;

// ---- the pen ------------------------------------------------------------------------------------

/** Whether a pen node is smooth: two handles, the outgoing one mirroring the incoming one. */
function mirrored(n: PenNode): boolean {
  return !!n.in && !!n.out && near(reflect(n.in, n), n.out, 1e-6);
}

/**
 * Pen nodes with their numbers rounded by `round`; a smooth node stays smooth (its outgoing
 * handle is the rounded incoming one, mirrored), so it can still be written with `S`.
 */
export function roundPen(nodes: PenNode[], round: (p: Pt) => Pt): PenNode[] {
  return nodes.map((n) => {
    const p = round(n);
    const handleIn = n.in && round(n.in);
    const handleOut = mirrored(n) && handleIn ? reflect(handleIn, p) : n.out && round(n.out);
    return { ...p, in: handleIn, out: handleOut, arc: n.arc && round(n.arc) };
  });
}

/** A curve from node `a` to `b`: `S` when `a` is smooth after a curve (issue #38), else `C`. */
function penCurve(a: PenNode, b: PenNode, afterCurve: boolean): string {
  if (afterCurve && !a.arc && mirrored(a)) return `S ${pt(b.in ?? b)} ${pt(b)}`;
  return `C ${pt(a.out ?? a)} ${pt(b.in ?? b)} ${pt(b)}`;
}

/** The circle through three points; null when they are (nearly) in a line. */
function circleThrough(a: Pt, b: Pt, c: Pt): { center: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const size = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y), Math.hypot(c.x - b.x, c.y - b.y));
  if (Math.abs(d) < 1e-6 * size * size || size < 1e-9) return null;
  const sa = a.x * a.x + a.y * a.y;
  const sb = b.x * b.x + b.y * b.y;
  const sc = c.x * c.x + c.y * c.y;
  const center = { x: (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d, y: (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d };
  return { center, r: Math.hypot(a.x - center.x, a.y - center.y) };
}

/**
 * The numbers of a circle arc from `from` through `through` to `to` (issue #39): radius, and
 * which of the four arcs (`large`, `sweep`). Null when the three points are in a line.
 */
export function arcThrough(from: Pt, through: Pt, to: Pt): ArcFlags | null {
  const c = circleThrough(from, through, to);
  if (!c || near(from, to)) return null;
  const turn = 2 * Math.PI;
  const angle = (p: Pt) => Math.atan2(p.y - c.center.y, p.x - c.center.x);
  const norm = (v: number) => ((v % turn) + turn) % turn;
  const a0 = angle(from);
  const toEnd = norm(angle(to) - a0);
  // Going the way angles grow (`sweep` 1: clockwise on screen), `through` comes before `to`.
  const sweep = norm(angle(through) - a0) < toEnd ? 1 : 0;
  const length = sweep ? toEnd : turn - toEnd;
  return { rx: c.r, ry: c.r, rot: 0, large: length > Math.PI + 1e-9 ? 1 : 0, sweep };
}

/** The point a half circle from `a` to `b` passes through: on the right, going from `a` to `b` (clockwise). */
export function halfCircle(a: Pt, b: Pt): Pt {
  const m = mid(a, b);
  return { x: m.x - (b.y - a.y) / 2, y: m.y + (b.x - a.x) / 2 };
}

/** A circle arc from `a` to `b` through `through`: `A r r 0 large sweep x,y`, or a line when they are in a line. */
export function penArc(a: Pt, through: Pt, b: Pt): string {
  const f = arcThrough(a, through, b);
  return f ? `A ${num(f.rx)} ${num(f.ry)} 0 ${f.large} ${f.sweep} ${pt(b)}` : `L ${pt(b)}`;
}

/** One side from node `a` to `b`: an arc (`b.arc`), a curve when either has a handle, else a line. */
function penSide(a: PenNode, b: PenNode, afterCurve: boolean): string {
  if (b.arc) return penArc(a, b.arc, b);
  return a.out || b.in ? penCurve(a, b, afterCurve) : `L ${pt(b)}`;
}

/**
 * Path text for pen nodes: `M 10,20 C 30,20 50,40 50,60 S 80,40 80,60 L 90,60 Z`. Between two
 * nodes the edge is a curve when either has a handle on that side, an arc when the node it
 * goes to has one, otherwise a line. A curve leaving a smooth node is written `S`: its first
 * handle mirrors the one before (issue #38).
 */
export function penPathData(nodes: PenNode[], closed: boolean): string {
  if (nodes.length === 0) return "";
  const parts = [`M ${pt(nodes[0])}`];
  const edges = penEdges(nodes);
  if (edges) parts.push(edges);
  if (closed && nodes.length > 1) parts.push(penClose(nodes[nodes.length - 1], nodes[0], nodes[0].arc));
  return parts.join(" ");
}

/**
 * The edges between pen nodes, without the `M`: `C 30,20 50,40 50,60 L 80,60`. The first edge
 * is never `S`: what comes before it in the text is not known here.
 */
export function penEdges(nodes: PenNode[]): string {
  const parts: string[] = [];
  // A node's incoming handle means the edge before it (written just before) is a curve.
  for (let i = 0; i + 1 < nodes.length; i++) parts.push(penSide(nodes[i], nodes[i + 1], i > 0));
  return parts.join(" ");
}

/**
 * Closes a path from node `a` back to the start `b`: a curve or an arc (through `arc`) then
 * `Z`, or just `Z` (its line). The curve is `S` when `a` is smooth: its incoming handle belongs
 * to the edge written before.
 */
export function penClose(a: PenNode, b: PenNode, arc?: Pt): string {
  if (arc) return `${penArc(a, arc, b)} Z`;
  return a.out || b.in ? `${penCurve(a, b, true)} Z` : "Z";
}

/**
 * Pen nodes for a smooth curve through `points` (issue #36), for people who would rather not
 * pull handles. At each point the handles lie along the line between its two neighbours, each a
 * third of its side long, so the curve passes every point smoothly without swinging wide where
 * points are far apart. Open ends point to the next handle; two points give a straight line.
 * `closed`: the curve goes round through the first point too.
 */
export function smoothThrough(points: Pt[], closed: boolean): PenNode[] {
  const n = points.length;
  const nodes: PenNode[] = points.map((p) => ({ x: p.x, y: p.y }));
  if (n < 3) return nodes;
  const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const p = points[i];
    const len = dist(prev, next);
    if (len < 1e-9) continue;
    const u = { x: (next.x - prev.x) / len, y: (next.y - prev.y) / len };
    const back = dist(prev, p) / 3;
    const ahead = dist(p, next) / 3;
    nodes[i].in = { x: p.x - u.x * back, y: p.y - u.y * back };
    nodes[i].out = { x: p.x + u.x * ahead, y: p.y + u.y * ahead };
  }
  if (!closed) {
    nodes[0].out = toward(points[0], nodes[1].in!, 0.5);
    nodes[n - 1].in = toward(points[n - 1], nodes[n - 2].out!, 0.5);
  }
  return nodes;
}

/**
 * The same nodes drawn the other way: reversed, each node's handles swapped. An arc stays on
 * its side, which now arrives at the other node; the first node keeps the closing side's arc.
 */
export function reversePen(nodes: PenNode[]): PenNode[] {
  const n = nodes.length;
  return [...nodes].reverse().map((p, k) => ({ x: p.x, y: p.y, in: p.out, out: p.in, arc: nodes[(n - k) % n].arc }));
}

// ---- reading a path -----------------------------------------------------------------------------

interface ArcFlags {
  rx: number;
  ry: number;
  rot: number;
  large: number;
  sweep: number;
}

/** One segment as written (its command, where it is in the text) and what it draws (absolute). */
interface Seg {
  /** The command that applies, e.g. `l` for a pair written after `m`. */
  letter: string;
  upper: string;
  rel: boolean;
  /** Its letter is written in the text (not a repeat of the previous segment's command). */
  explicit: boolean;
  /** Text range: from its letter (or first number) to its last number. */
  start: number;
  end: number;
  /** The current point before and after it. */
  from: Pt;
  to: Pt;
  /** A cubic curve's control points (`S`: the first is the mirrored one). */
  c1?: Pt;
  c2?: Pt;
  /** A quadratic curve's control point (`T`: the mirrored one). */
  q?: Pt;
  arc?: ArcFlags;
  /** Start of its subpath, where `Z` goes back to. */
  subStart: Pt;
  /** Its numbers as written, with their place in the text. */
  nums: { value: number; start: number; end: number }[];
}

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Reads path text into segments, or null when it is not a path these edits understand. */
function parseSegs(d: string): Seg[] | null {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)|(.)/g;
  const tokens: { cmd?: string; value?: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (m[4]) return null;
    if (m[1]) tokens.push({ cmd: m[1], start: m.index, end: m.index + 1 });
    else if (m[2]) tokens.push({ value: Number(m[2]), start: m.index, end: m.index + m[2].length });
  }
  const segs: Seg[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let subStart: Pt = cur;
  let i = 0;
  while (i < tokens.length) {
    const c = tokens[i];
    if (c.cmd === undefined) return null;
    const upper = c.cmd.toUpperCase();
    const rel = c.cmd !== upper;
    if (segs.length === 0 && upper !== "M") return null;
    // After `Z` only a new `M` (another command would start a subpath with no point of its own).
    if (segs.length > 0 && segs[segs.length - 1].upper === "Z" && upper !== "M") return null;
    i++;
    if (upper === "Z") {
      segs.push({ letter: c.cmd, upper, rel, explicit: true, start: c.start, end: c.end, from: cur, to: subStart, subStart, nums: [] });
      cur = subStart;
      continue;
    }
    const n = ARGS[upper];
    let group = 0;
    while (i < tokens.length && tokens[i].value !== undefined) {
      const nums = tokens.slice(i, i + n);
      if (nums.length < n || nums.some((t) => t.value === undefined)) return null;
      const a = nums.map((t) => t.value!);
      const kind = upper === "M" && group > 0 ? "L" : upper;
      const letter = upper === "M" && group > 0 ? (rel ? "l" : "L") : c.cmd;
      const base = rel ? cur : { x: 0, y: 0 };
      const p = (k: number): Pt => ({ x: base.x + a[k], y: base.y + a[k + 1] });
      const prev = segs[segs.length - 1];
      const seg: Seg = {
        letter,
        upper: kind,
        rel,
        explicit: group === 0,
        start: group === 0 ? c.start : nums[0].start,
        end: nums[n - 1].end,
        from: cur,
        to: cur,
        subStart,
        nums: nums.map((t) => ({ value: t.value!, start: t.start, end: t.end })),
      };
      switch (kind) {
        case "M":
          seg.to = p(0);
          subStart = seg.to;
          seg.subStart = subStart;
          break;
        case "L":
          seg.to = p(0);
          break;
        case "H":
          seg.to = { x: base.x + a[0], y: cur.y };
          break;
        case "V":
          seg.to = { x: cur.x, y: (rel ? cur.y : 0) + a[0] };
          break;
        case "C":
          seg.c1 = p(0);
          seg.c2 = p(2);
          seg.to = p(4);
          break;
        case "S":
          seg.c1 = prev?.c2 && (prev.upper === "C" || prev.upper === "S") ? reflect(prev.c2, cur) : cur;
          seg.c2 = p(0);
          seg.to = p(2);
          break;
        case "Q":
          seg.q = p(0);
          seg.to = p(2);
          break;
        case "T":
          seg.q = prev?.q && (prev.upper === "Q" || prev.upper === "T") ? reflect(prev.q, cur) : cur;
          seg.to = p(0);
          break;
        case "A":
          if ((a[3] !== 0 && a[3] !== 1) || (a[4] !== 0 && a[4] !== 1)) return null;
          seg.arc = { rx: a[0], ry: a[1], rot: a[2], large: a[3], sweep: a[4] };
          seg.to = p(5);
          break;
      }
      segs.push(seg);
      cur = seg.to;
      i += n;
      group++;
    }
    if (group === 0) return null;
  }
  return segs.length > 0 ? segs : null;
}

/**
 * The path's points (nodes) and sides, as the drawing area shows them. A node is the end of a
 * segment, except an end written on the start point just before `Z` (it is the start point). A
 * side is every segment after `M`, and `Z` when it draws a line back to the start.
 */
function structure(segs: Seg[]): { nodes: number[]; sides: number[] } {
  const nodes: number[] = [];
  const sides: number[] = [];
  segs.forEach((s, k) => {
    if (s.upper === "Z") {
      const prev = segs[k - 1];
      if (prev && prev.upper !== "M" && near(prev.to, s.subStart)) return; // the side before closes it
      sides.push(k);
      return;
    }
    const next = segs[k + 1];
    const merged = s.upper !== "M" && next?.upper === "Z" && near(s.to, s.subStart);
    if (!merged) nodes.push(k);
    if (s.upper !== "M") sides.push(k);
  });
  return { nodes, sides };
}

/** Whether points of this path text can be added and deleted (and the path continued). */
export function isEditablePath(d: string): boolean {
  return parseSegs(d) !== null;
}

// ---- curve maths --------------------------------------------------------------------------------

const lineLike = (s: Seg) => s.upper === "L" || s.upper === "H" || s.upper === "V" || s.upper === "Z";

function cubicAt(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

/** An arc as a center and angles (SVG's endpoint to center conversion); null when it is a line. */
function arcCenter(from: Pt, to: Pt, f: ArcFlags) {
  let rx = Math.abs(f.rx);
  let ry = Math.abs(f.ry);
  if (rx < 1e-9 || ry < 1e-9 || near(from, to)) return null;
  const phi = (f.rot * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const bottom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, top / bottom));
  if (f.large === f.sweep) co = -co;
  const cx1 = (co * rx * y1) / ry;
  const cy1 = (-co * ry * x1) / rx;
  const center = { x: cos * cx1 - sin * cy1 + (from.x + to.x) / 2, y: sin * cx1 + cos * cy1 + (from.y + to.y) / 2 };
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!f.sweep && delta > 0) delta -= 2 * Math.PI;
  else if (f.sweep && delta < 0) delta += 2 * Math.PI;
  const at = (theta: number): Pt => ({
    x: center.x + rx * cos * Math.cos(theta) - ry * sin * Math.sin(theta),
    y: center.y + rx * sin * Math.cos(theta) + ry * cos * Math.sin(theta),
  });
  return { rx, ry, start, delta, at, center };
}

/** The middle of a segment, on its curve. */
function middleOf(s: Seg): Pt {
  if (s.c1 && s.c2) return cubicAt(s.from, s.c1, s.c2, s.to, 0.5);
  if (s.q) return { x: (s.from.x + 2 * s.q.x + s.to.x) / 4, y: (s.from.y + 2 * s.q.y + s.to.y) / 4 };
  if (s.arc) {
    const c = arcCenter(s.from, s.to, s.arc);
    if (c) return c.at(c.start + c.delta / 2);
  }
  return mid(s.from, s.to);
}

/** A curve's first control point as a cubic (a quadratic's, raised; a line or arc: its start). */
function firstControl(s: Seg): Pt {
  if (s.c1) return s.c1;
  if (s.q) return toward(s.from, s.q, 2 / 3);
  return s.from;
}

/** A curve's last control point as a cubic. */
function lastControl(s: Seg): Pt {
  if (s.c2) return s.c2;
  if (s.q) return toward(s.to, s.q, 2 / 3);
  return s.to;
}

// ---- writing segments ---------------------------------------------------------------------------

/** What a new segment draws, in absolute numbers. */
interface Geo {
  to: Pt;
  c1?: Pt;
  c2?: Pt;
  q?: Pt;
  arc?: ArcFlags;
}

/**
 * Segment text for command `upper`, absolute or relative to `from`, rounding new numbers with
 * `round`. `comma`: pairs written `x,y` (else `x y`), as the path already does.
 */
function write(upper: string, rel: boolean, from: Pt, g: Geo, comma: boolean, round: (n: number) => number = (n) => n): string {
  const letter = rel ? upper.toLowerCase() : upper;
  // Absolute numbers are rounded; relative ones are measured from the exact current point.
  const n = (v: number) => (rel ? num(v) : num(round(v)));
  const p = (q: Pt) => `${n(rel ? q.x - from.x : q.x)}${comma ? "," : " "}${n(rel ? q.y - from.y : q.y)}`;
  switch (upper) {
    case "Z":
      return letter;
    case "H":
      return `${letter} ${n(rel ? g.to.x - from.x : g.to.x)}`;
    case "V":
      return `${letter} ${n(rel ? g.to.y - from.y : g.to.y)}`;
    case "C":
      return `${letter} ${p(g.c1!)} ${p(g.c2!)} ${p(g.to)}`;
    case "S":
      return `${letter} ${p(g.c2!)} ${p(g.to)}`;
    case "Q":
      return `${letter} ${p(g.q!)} ${p(g.to)}`;
    case "A": {
      const a = g.arc!;
      return `${letter} ${num(a.rx)} ${num(a.ry)} ${num(a.rot)} ${a.large} ${a.sweep} ${p(g.to)}`;
    }
    default:
      return `${letter} ${p(g.to)}`; // M, L, T
  }
}

/** A line to `to`: `H` / `V` when the segment was one and the line still fits it, else `L`. */
function lineUpper(was: string, from: Pt, to: Pt): string {
  if (was === "H" && Math.abs(from.y - to.y) < 1e-9) return "H";
  if (was === "V" && Math.abs(from.x - to.x) < 1e-9) return "V";
  return "L";
}

/** One text change: replaces `[start, end)`; `next` is the segment after it, whose letter may be needed. */
interface Change {
  start: number;
  end: number;
  text: string;
  next?: number;
}

/** Applies changes (back to front). A following segment written without its letter gets it. */
function apply(d: string, segs: Seg[], changes: Change[]): string {
  let out = d;
  for (const c of [...changes].sort((a, b) => b.start - a.start)) {
    const next = c.next !== undefined ? segs[c.next] : undefined;
    const text = next && !next.explicit ? `${c.text} ${next.letter}` : c.text;
    out = out.slice(0, c.start) + text + out.slice(c.end);
  }
  return out;
}

/** Same drawing, within the 3 decimals numbers are written with. */
function sameSeg(a: Seg, b: Seg): boolean {
  const eq = (p?: Pt, q?: Pt) => (!p && !q) || (!!p && !!q && near(p, q, 1e-3));
  const arcEq = !a.arc || (!!b.arc && a.arc.rx === b.arc.rx && a.arc.ry === b.arc.ry && a.arc.rot === b.arc.rot && a.arc.large === b.arc.large && a.arc.sweep === b.arc.sweep);
  return a.upper === b.upper && eq(a.to, b.to) && eq(a.c1, b.c1) && eq(a.c2, b.c2) && eq(a.q, b.q) && arcEq;
}

/**
 * After an edit, the segments from old index `first` on are unchanged text. Rewrites any of them
 * that now draws differently: an `S` / `T` whose mirrored handle changed becomes `C` / `Q`, and a
 * relative segment measured from a point that moved gets new numbers. Each keeps its case.
 */
function keepFollowing(d: string, old: Seg[], first: number, comma: boolean, end = old.length): string {
  // To the end of the path, segments are matched from the end; before a later change (\`end\`),
  // they keep their index (the change before them replaced one segment with one).
  const count = end - first;
  let text = d;
  for (let t = 0; t < count; t++) {
    const segs = parseSegs(text);
    if (!segs) return text;
    const k = end === old.length ? segs.length - count + t : first + t;
    const o = old[first + t];
    const s = segs[k];
    if (!s || o.upper === "Z" || sameSeg(o, s)) continue;
    let upper = o.upper === "S" ? "C" : o.upper === "T" ? "Q" : o.upper;
    if (upper === "H" || upper === "V") upper = lineUpper(upper, s.from, o.to);
    const letter = write(upper, o.rel, s.from, o, comma);
    text = apply(text, segs, [{ start: s.start, end: s.end, text: letter, next: k + 1 }]);
  }
  return text;
}

/** Commas between x and y, as the path already writes them. */
const usesCommas = (d: string) => /\d\s*,\s*[-+.\d]/.test(d) || !/\d\s+[-+.\d]/.test(d);

// ---- editing ------------------------------------------------------------------------------------

/** The middle of each side, in the path's own numbers (on the curve for curves); null if not editable. */
export function pathSides(d: string): Pt[] | null {
  const segs = parseSegs(d);
  if (!segs) return null;
  return structure(segs).sides.map((k) => {
    const s = segs[k];
    return s.upper === "Z" ? mid(s.from, s.to) : middleOf(s);
  });
}

/**
 * Adds a point in the middle of side `side`, moved by (dx, dy). A curve is split in two that
 * draw the same shape (when not moved), of the same kind and case. Returns the new text and the
 * new point's node index, or a reason.
 */
export function splitPathSide(d: string, side: number, dx: number, dy: number, round: (n: number) => number = (n) => n): { d: string; node: number } | string {
  const segs = parseSegs(d);
  const k = segs && structure(segs).sides[side];
  if (!segs || k === undefined || k === null) return "this side cannot be found in `d`";
  const s = segs[k];
  const comma = usesCommas(d);
  const r = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });
  const w = (upper: string, from: Pt, g: Geo) => write(upper, s.rel, from, g, comma, round);
  const a = s.from;
  const b = s.to;
  let text: string;
  let node: Pt;
  if (s.c1 && s.c2) {
    // de Casteljau at t = 0.5: two cubic curves. Of an `S`, the first half needs a handle of its
    // own (`C`); the second half's handle mirrors the first's, so it stays `S`.
    const p01 = mid(a, s.c1);
    const p12 = mid(s.c1, s.c2);
    const p23 = mid(s.c2, b);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    node = r(shift(mid(p012, p123), dx, dy));
    const first = { c1: r(p01), c2: r(shift(p012, dx, dy)), to: node };
    const second = { c1: r(shift(p123, dx, dy)), c2: r(p23), to: b };
    text = `${w("C", a, first)} ${w(s.upper === "S" ? "S" : "C", node, second)}`;
  } else if (s.q) {
    const q1 = mid(a, s.q);
    const q2 = mid(s.q, b);
    node = r(shift(mid(q1, q2), dx, dy));
    text = `${w("Q", a, { q: r(q1), to: node })} ${w("Q", node, { q: r(q2), to: b })}`;
  } else if (s.arc && arcCenter(a, b, s.arc)) {
    const c = arcCenter(a, b, s.arc)!;
    node = r(shift(c.at(c.start + c.delta / 2), dx, dy));
    // Each half turns less than half a circle; the radii are the ones the arc is drawn with.
    const half = { rx: round(c.rx), ry: round(c.ry), rot: s.arc.rot, large: 0, sweep: s.arc.sweep };
    text = `${w("A", a, { arc: half, to: node })} ${w("A", node, { arc: half, to: b })}`;
  } else if (s.upper === "Z") {
    node = r(shift(mid(a, b), dx, dy));
    text = `${w("L", a, { to: node })} ${s.letter}`;
  } else {
    node = r(shift(mid(a, b), dx, dy));
    text = `${w(lineUpper(s.upper, a, node), a, { to: node })} ${w(lineUpper(s.upper, node, b), node, { to: b })}`;
  }
  const out = keepFollowing(apply(d, segs, [{ start: s.start, end: s.end, text, next: k + 1 }]), segs, k + 1, comma);
  const after = parseSegs(out);
  const index = after ? structure(after).nodes.indexOf(k) : -1;
  return { d: out, node: index };
}

/** One segment from `a.from` to `b.to` in place of two: lines stay a line, an arc stays an arc, else a cubic curve. */
function merged(a: Seg, b: Seg, comma: boolean, rel = a.rel): string {
  const from = a.from;
  const to = b.to;
  if (lineLike(a) && lineLike(b)) return write(lineUpper(a.upper === "Z" ? b.upper : a.upper, from, to), rel, from, { to }, comma);
  const arc = a.arc ?? b.arc;
  if (arc) {
    const spans = [a, b].map((s) => (s.arc ? Math.abs(arcCenter(s.from, s.to, s.arc)?.delta ?? 0) : 0));
    const large = a.arc && b.arc ? (spans[0] + spans[1] > Math.PI ? 1 : 0) : arc.large;
    return write("A", rel, from, { arc: { ...arc, large }, to }, comma);
  }
  return write("C", rel, from, { c1: firstControl(a), c2: lastControl(b), to }, comma);
}

/**
 * Deletes node `node`: the two sides around it become one (a curve keeps the outer control
 * points). A subpath keeps at least 2 nodes.
 */
export function deletePathNode(d: string, node: number): string | { error: string } {
  const segs = parseSegs(d);
  const k = segs && structure(segs).nodes[node];
  if (!segs || k === undefined || k === null) return { error: "this point cannot be found in `d`" };
  const comma = usesCommas(d);
  // The subpath: from its `M` to the segment before the next `M`.
  let ms = k;
  while (segs[ms].upper !== "M") ms--;
  let me = k;
  while (me + 1 < segs.length && segs[me + 1].upper !== "M") me++;
  const { nodes } = structure(segs);
  if (nodes.filter((n) => n >= ms && n <= me).length <= 2) return { error: "a path needs at least 2 points, so this one cannot be deleted" };
  const closed = segs[me].upper === "Z";
  const last = closed ? me - 1 : me;
  const s = segs[k];
  const changes: Change[] = [];
  let firstKept = k + 2;
  if (k === ms) {
    // The start point: the next point becomes the start.
    const s1 = segs[ms + 1];
    const text = keepFollowing(apply(d, segs, [{ start: s.start, end: s1.end, text: write("M", s.rel, s.from, { to: s1.to }, comma), next: ms + 2 }]), segs, ms + 2, comma);
    if (!closed) return text;
    // Closed: the way back to the start now goes to the new start. One segment fewer from here on.
    const now = parseSegs(text);
    if (!now) return text;
    const end = now[last - 1];
    const z = now[me - 1];
    let back: Change | null = null;
    if (last !== ms + 1 && near(segs[last].to, s.to)) {
      // The side that came back to the old start now comes back to the new one.
      back = { start: end.start, end: end.end, text: merged(segs[last], s1, comma, end.rel), next: me - 1 };
    } else if (!lineLike(s1)) {
      // `Z` drew a line to the old start: a curve to the new start goes before it.
      const line = { ...segs[me], from: segs[last].to, to: s.to };
      back = { start: z.start, end: z.end, text: `${merged(line, s1, comma, z.rel)} ${z.letter}` };
    }
    return back ? keepFollowing(apply(text, now, [back]), now, me, comma) : text;
  } else if (!closed && k === me) {
    // The last point of an open subpath: its side goes.
    changes.push({ start: segs[k - 1].end, end: s.end, text: "" });
    firstKept = k + 1;
  } else if (closed && k === last) {
    // The last point before `Z`'s line: the side to it and the line back become one.
    const z = segs[me];
    const line = { ...z, from: s.to, to: z.to };
    changes.push(lineLike(s) ? { start: segs[k - 1].end, end: s.end, text: "" } : { start: s.start, end: s.end, text: merged(s, line, comma), next: k + 1 });
    firstKept = k + 1;
  } else {
    const next = segs[k + 1];
    changes.push({ start: s.start, end: next.end, text: merged(s, next, comma), next: k + 2 });
  }
  return keepFollowing(apply(d, segs, changes), segs, firstKept, comma);
}

/**
 * The two ends of a path that can be continued (issue #34): one subpath, not closed. Null for
 * any other path.
 */
export function openPathEnds(d: string): { start: Pt; end: Pt } | null {
  const segs = parseSegs(d);
  if (!segs || segs.some((s, i) => (s.upper === "M" && i > 0) || s.upper === "Z")) return null;
  return { start: segs[0].to, end: segs[segs.length - 1].to };
}

/**
 * Continues an open path (issue #34) with pen nodes in the path's own numbers: node 0 is the end
 * drawing goes on from. At the end, the new part is added after the last segment; at the start,
 * the new points come first and the old `M` point becomes a line or curve to them. `close`
 * joins the last new point to the other end.
 */
export function continuePathText(d: string, at: "start" | "end", nodes: PenNode[], close: boolean): string | { error: string } {
  const segs = parseSegs(d);
  const ends = openPathEnds(d);
  if (!segs || !ends) return { error: "only open paths with one part can be continued" };
  const tail = d.trimEnd().length;
  if (at === "end") {
    const added = [penEdges(nodes), close ? penClose(nodes[nodes.length - 1], ends.start, nodes[0].arc) : ""].filter(Boolean).join(" ");
    return d.slice(0, tail) + " " + added + d.slice(tail);
  }
  const reversed = reversePen(nodes);
  const m = segs[0];
  // The old first side may mirror a handle (`S`, `T`) that is now a new curve's: keep it as it was.
  const text = keepFollowing(apply(d, segs, [{ start: m.start, end: m.end, text: penPathData(reversed, false), next: 1 }]), segs, 1, usesCommas(d));
  if (!close) return text;
  const end = text.trimEnd().length;
  return text.slice(0, end) + " " + penClose({ x: ends.end.x, y: ends.end.y }, reversed[0], reversed[0].arc) + text.slice(end);
}

// ---- bending sides and corner / smooth points (issue #35) ----------------------------------------

/** A side as a cubic curve (a line: handles a third of the way along); null for an arc. */
function asCubic(s: Seg): { a: Pt; c1: Pt; c2: Pt; b: Pt } | null {
  if (s.arc && arcCenter(s.from, s.to, s.arc)) return null;
  const a = s.from;
  const b = s.to;
  if (s.c1 && s.c2) return { a, c1: s.c1, c2: s.c2, b };
  if (s.q) return { a, c1: toward(a, s.q, 2 / 3), c2: toward(b, s.q, 2 / 3), b };
  return { a, c1: toward(a, b, 1 / 3), c2: toward(a, b, 2 / 3), b };
}

/** A side that is part of a circle (`rx` = `ry`): its center and radius as drawn (issue #39); else null. */
function circleArc(s: Seg): { center: Pt; r: number } | null {
  if (!s.arc || Math.abs(Math.abs(s.arc.rx) - Math.abs(s.arc.ry)) > 1e-9) return null;
  const c = arcCenter(s.from, s.to, s.arc);
  return c && { center: c.center, r: c.rx };
}

/**
 * Each side as its own SVG path text (`M ... C ...`, or `M ... A ...` for a circle arc, in
 * the path's own numbers), for grabbing it in the drawing area; null for a side that cannot be
 * bent (an arc that is part of an ellipse).
 */
export function pathSideCurves(d: string): (string | null)[] | null {
  const segs = parseSegs(d);
  if (!segs) return null;
  return structure(segs).sides.map((k) => {
    const s = segs[k];
    if (s.arc && circleArc(s)) return `M ${pt(s.from)} A ${num(Math.abs(s.arc.rx))} ${num(Math.abs(s.arc.ry))} ${num(s.arc.rot)} ${s.arc.large} ${s.arc.sweep} ${pt(s.to)}`;
    const c = asCubic(s);
    return c && `M ${pt(c.a)} C ${pt(c.c1)} ${pt(c.c2)} ${pt(c.b)}`;
  });
}

/**
 * Bends a circle arc (issue #39): the spot held on it moves by (dx, dy), and the arc becomes
 * the circle arc through the new spot, its ends kept: new radius and flags, same case.
 */
function bendArc(d: string, segs: Seg[], k: number, grab: Pt, dx: number, dy: number, round: (n: number) => number): string | { error: string } {
  const s = segs[k];
  const c = circleArc(s)!;
  // The spot on the arc nearest to where the mouse took hold of it.
  const len = Math.hypot(grab.x - c.center.x, grab.y - c.center.y);
  const on = len < 1e-9 ? middleOf(s) : { x: c.center.x + ((grab.x - c.center.x) / len) * c.r, y: c.center.y + ((grab.y - c.center.y) / len) * c.r };
  const through = shift(on, dx, dy);
  const f = near(through, s.from, 1e-6) || near(through, s.to, 1e-6) ? null : arcThrough(s.from, through, s.to);
  if (!f) return { error: "the arc would be a straight line here" };
  const arc = { ...f, rx: round(f.rx), ry: round(f.ry), rot: s.arc!.rot };
  const comma = usesCommas(d);
  const text = write("A", s.rel, s.from, { to: s.to, arc }, comma, round);
  return keepFollowing(apply(d, segs, [{ start: s.start, end: s.end, text, next: k + 1 }]), segs, k + 1, comma);
}

/**
 * Bends side `side` (issue #35): the spot `grab` on it (the path's own numbers) moves by
 * (dx, dy), and the side becomes a curve (`C`, same case) through the new spot. Both handles
 * move together, so a straight side bends evenly. A circle arc stays one, through the new spot
 * (issue #39); an arc that is part of an ellipse cannot be bent.
 */
export function bendPathSide(d: string, side: number, grab: Pt, dx: number, dy: number, round: (n: number) => number = (n) => n): string | { error: string } {
  const segs = parseSegs(d);
  const k = segs && structure(segs).sides[side];
  if (!segs || k === undefined || k === null) return { error: "this side cannot be found in `d`" };
  const s = segs[k];
  if (s.arc && circleArc(s)) return bendArc(d, segs, k, grab, dx, dy, round);
  const c = asCubic(s);
  if (!c) return { error: "an arc that is part of an ellipse cannot be bent: drag its points instead" };
  // Where on the side the mouse took hold of it (kept away from the ends, which do not move).
  let t0 = 0.5;
  let best = Infinity;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const p = cubicAt(c.a, c.c1, c.c2, c.b, t);
    const dist = Math.hypot(p.x - grab.x, p.y - grab.y);
    if (dist < best) {
      best = dist;
      t0 = t;
    }
  }
  t0 = Math.min(0.85, Math.max(0.15, t0));
  // Moving both handles by m moves the point at t0 by 3 t0 (1 - t0) m.
  const f = 3 * t0 * (1 - t0);
  const r = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });
  const g = { c1: r(shift(c.c1, dx / f, dy / f)), c2: r(shift(c.c2, dx / f, dy / f)), to: c.b };
  const comma = usesCommas(d);
  const curve = write("C", s.rel, c.a, g, comma, round);
  const text = s.upper === "Z" ? `${curve} ${s.letter}` : curve;
  return keepFollowing(apply(d, segs, [{ start: s.start, end: s.end, text, next: k + 1 }]), segs, k + 1, comma);
}

/** The sides on either side of node `node`: segment indexes (a `Z` drawing a line counts), or null at an open end. */
function nodeSides(segs: Seg[], node: number): { incoming: number; outgoing: number } | null {
  const k = structure(segs).nodes[node];
  if (k === undefined) return null;
  let ms = k;
  while (segs[ms].upper !== "M") ms--;
  let me = k;
  while (me + 1 < segs.length && segs[me + 1].upper !== "M") me++;
  const closed = segs[me].upper === "Z";
  const last = closed ? me - 1 : me;
  const mergedClose = closed && last !== ms && near(segs[last].to, segs[ms].to);
  let incoming: number | null = k;
  let outgoing: number | null = k + 1 <= last ? k + 1 : null;
  if (k === ms) incoming = closed ? (mergedClose ? last : me) : null;
  if (k === last && closed && !mergedClose) outgoing = me;
  if (incoming === null || outgoing === null || outgoing === incoming) return null;
  return { incoming, outgoing };
}

/** Whether two handles of a node point in opposite directions. */
function opposite(node: Pt, a: Pt, b: Pt): boolean {
  const u = { x: a.x - node.x, y: a.y - node.y };
  const v = { x: b.x - node.x, y: b.y - node.y };
  const lu = Math.hypot(u.x, u.y);
  const lv = Math.hypot(v.x, v.y);
  if (lu < 1e-6 || lv < 1e-6) return false;
  return (u.x * v.x + u.y * v.y) / (lu * lv) < -0.999;
}

/**
 * Whether point `node` is smooth (its two handles in a straight line) or a corner; null when it
 * cannot be switched: an end of an open path, or next to an arc.
 */
export function pathNodeKind(d: string, node: number): "smooth" | "corner" | null {
  const segs = parseSegs(d);
  const sides = segs && nodeSides(segs, node);
  if (!segs || !sides) return null;
  const inc = asCubic(segs[sides.incoming]);
  const out = asCubic(segs[sides.outgoing]);
  if (!inc || !out) return null;
  // A line has no handles: its "handles" a third of the way along do not count.
  const handleIn = lineLike(segs[sides.incoming]) ? null : inc.c2;
  const handleOut = lineLike(segs[sides.outgoing]) ? null : out.c1;
  return handleIn && handleOut && opposite(inc.b, handleIn, handleOut) ? "smooth" : "corner";
}

/**
 * Makes point `node` smooth or a corner (issue #35). Smooth: its two handles in a line along
 * the direction from the point before to the point after, each as long as before (a third of
 * the side when it had none). Corner: its handles go; a side with no handle left becomes a
 * line again. Only the two sides around the point change, in their own case.
 */
export function setPathNodeSmooth(d: string, node: number, smooth: boolean, round: (n: number) => number = (n) => n): string | { error: string } {
  const segs = parseSegs(d);
  const sides = segs && nodeSides(segs, node);
  if (!segs || !sides) return { error: "an end of an open path has only one side, so it has no corner to change" };
  const si = segs[sides.incoming];
  const so = segs[sides.outgoing];
  const inc = asCubic(si);
  const out = asCubic(so);
  if (!inc || !out) return { error: "a point next to an arc cannot be switched: arcs have no handles" };
  const p = inc.b;
  const comma = usesCommas(d);
  const r = (q: Pt): Pt => ({ x: round(q.x), y: round(q.y) });
  const lineIn = lineLike(si);
  const lineOut = lineLike(so);
  let inC1 = inc.c1;
  let inC2: Pt;
  let outC1: Pt;
  let outC2 = out.c2;
  if (smooth) {
    const dir = { x: out.b.x - inc.a.x, y: out.b.y - inc.a.y };
    const len = Math.hypot(dir.x, dir.y);
    if (len < 1e-9) return { error: "this point's neighbours are in the same place, so there is no direction to smooth along" };
    const u = { x: dir.x / len, y: dir.y / len };
    const lenIn = lineIn || near(inc.c2, p) ? Math.hypot(p.x - inc.a.x, p.y - inc.a.y) / 3 : Math.hypot(inc.c2.x - p.x, inc.c2.y - p.y);
    const lenOut = lineOut || near(out.c1, p) ? Math.hypot(out.b.x - p.x, out.b.y - p.y) / 3 : Math.hypot(out.c1.x - p.x, out.c1.y - p.y);
    inC2 = r({ x: p.x - u.x * lenIn, y: p.y - u.y * lenIn });
    outC1 = r({ x: p.x + u.x * lenOut, y: p.y + u.y * lenOut });
    // A line's far end has no handle: it stays on that end.
    if (lineIn) inC1 = inc.a;
    if (lineOut) outC2 = out.b;
  } else {
    if (lineIn && lineOut) return d;
    inC2 = p;
    outC1 = p;
  }
  // The new text of one side; a side whose handles both sit on its ends is a line again.
  const side = (s: Seg, c: { a: Pt; b: Pt }, c1: Pt, c2: Pt): string | null => {
    if (lineLike(s) && !smooth) return null; // a line stays as written
    const straight = near(c1, c.a, 1e-6) && near(c2, c.b, 1e-6);
    const text = straight ? write(lineUpper(s.upper === "Z" ? "L" : s.upper, c.a, c.b), s.rel, c.a, { to: c.b }, comma) : write("C", s.rel, c.a, { c1, c2, to: c.b }, comma, round);
    // A `Z` that drew a line: a curve now comes before it.
    if (s.upper === "Z") return straight ? null : `${text} ${s.letter}`;
    return text;
  };
  const changes: Change[] = [];
  const inText = side(si, inc, inC1, inC2);
  const outText = side(so, out, outC1, outC2);
  if (inText !== null) changes.push({ start: si.start, end: si.end, text: inText, next: sides.incoming + 1 });
  if (outText !== null) changes.push({ start: so.start, end: so.end, text: outText, next: sides.outgoing + 1 });
  if (changes.length === 0) return d;
  const text = apply(d, segs, changes);
  const first = Math.min(sides.incoming, sides.outgoing);
  const last = Math.max(sides.incoming, sides.outgoing);
  // Segments between the two changed sides (at the start of a closed path) keep their index.
  const between = last > first + 1 ? keepFollowing(text, segs, first + 1, comma, last) : text;
  return keepFollowing(between, segs, last + 1, comma);
}

// ---- explaining a path in plain words (issue #40) ------------------------------------------------

/** One number of a step: what it is, its value, and where it is in `d`. */
export interface StepNumber {
  label: string;
  value: number;
  start: number;
  end: number;
}

/** One step of a path, in plain words, with its numbers and what it draws. */
export interface PathStep {
  /** "Straight line to 150, 50", "Curve 50 right and 10 down (...)". */
  words: string;
  /** The command as written (`l` for a pair after `m`). */
  command: string;
  numbers: StepNumber[];
  /** Path text drawing only this step, in the path's own numbers (empty for a move). */
  highlight: string;
  /** Where the step ends (a move: the point it goes to). */
  at: Pt;
}

const LABELS: Record<string, string[]> = {
  M: ["x", "y"],
  L: ["x", "y"],
  H: ["x"],
  V: ["y"],
  C: ["handle 1 x", "handle 1 y", "handle 2 x", "handle 2 y", "x", "y"],
  S: ["handle x", "handle y", "x", "y"],
  Q: ["handle x", "handle y", "x", "y"],
  T: ["x", "y"],
  A: ["radius x", "radius y", "turn", "long way (1) or short (0)", "clockwise (1) or not (0)", "x", "y"],
  Z: [],
};

/** "50 right and 10 up": a relative move in words (y grows downwards). */
function moveWords(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx !== 0) parts.push(`${num(Math.abs(dx))} ${dx > 0 ? "right" : "left"}`);
  if (dy !== 0) parts.push(`${num(Math.abs(dy))} ${dy > 0 ? "down" : "up"}`);
  return parts.length > 0 ? parts.join(" and ") : "nowhere (0, 0)";
}

/**
 * The steps of path text `d` in plain words (issue #40), for every SVG command in both cases;
 * null when the text cannot be read (for example calculations in `( )`).
 */
export function pathSteps(d: string): PathStep[] | null {
  const segs = parseSegs(d);
  if (!segs) return null;
  const xy = (p: Pt) => `${num(p.x)}, ${num(p.y)}`;
  return segs.map((s, i): PathStep => {
    const a = s.nums.map((n) => n.value);
    const labels = LABELS[s.upper] ?? [];
    const numbers = s.nums.map((n, k) => ({ label: labels[k] ?? "", value: n.value, start: n.start, end: n.end }));
    // Relative: the numbers count from where the step starts.
    const rel = s.rel && !(s.upper === "M" && i === 0);
    const to = rel ? moveWords(s.to.x - s.from.x, s.to.y - s.from.y) : `to ${xy(s.to)}`;
    const handle = (k: number) => (rel ? `${num(a[k])}, ${num(a[k + 1])} from its start` : `${num(a[k])}, ${num(a[k + 1])}`);
    let words: string;
    let highlight = `M ${pt(s.from)} `;
    switch (s.upper) {
      case "M":
        words = i === 0 ? `Start at ${xy(s.to)}` : rel ? `Jump ${to} (a new part)` : `Jump to ${xy(s.to)} (a new part)`;
        highlight = "";
        break;
      case "L":
        words = `Straight line ${to}`;
        highlight += `L ${pt(s.to)}`;
        break;
      case "H":
        words = rel ? `Straight line ${moveWords(s.to.x - s.from.x, 0)}` : `Straight line across to x ${num(s.to.x)}`;
        highlight += `L ${pt(s.to)}`;
        break;
      case "V":
        words = rel ? `Straight line ${moveWords(0, s.to.y - s.from.y)}` : `Straight line up or down to y ${num(s.to.y)}`;
        highlight += `L ${pt(s.to)}`;
        break;
      case "C":
        words = `Curve ${to} (handles at ${handle(0)} and ${handle(2)})`;
        highlight += `C ${pt(s.c1!)} ${pt(s.c2!)} ${pt(s.to)}`;
        break;
      case "S":
        words = `Smooth curve ${to} (its first handle mirrors the curve before; second handle at ${handle(0)})`;
        highlight += `C ${pt(s.c1!)} ${pt(s.c2!)} ${pt(s.to)}`;
        break;
      case "Q":
        words = `Curve ${to} (pulled toward ${handle(0)})`;
        highlight += `Q ${pt(s.q!)} ${pt(s.to)}`;
        break;
      case "T":
        words = `Smooth curve ${to} (pulled the way the curve before was)`;
        highlight += `Q ${pt(s.q!)} ${pt(s.to)}`;
        break;
      case "A": {
        const f = s.arc!;
        const radius = f.rx === f.ry ? `radius ${num(f.rx)}` : `radius ${num(f.rx)} by ${num(f.ry)}`;
        const turn = f.rot !== 0 ? `, turned ${num(f.rot)}°` : "";
        words = `Arc ${to} (${radius}${turn}, the ${f.large ? "long" : "short"} way, ${f.sweep ? "clockwise" : "counterclockwise"})`;
        highlight += `A ${num(f.rx)} ${num(f.ry)} ${num(f.rot)} ${f.large} ${f.sweep} ${pt(s.to)}`;
        break;
      }
      default:
        words = "Close the shape: a straight line back to the start";
        highlight += `L ${pt(s.to)}`;
    }
    return { words, command: s.letter, numbers, highlight, at: s.to };
  });
}
