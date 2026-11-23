/**
 * Paths as nodes and edges, for the pen tool and for adding / deleting path points.
 *
 * Works on "simple" paths: absolute `M`, `L`, `H`, `V`, `C` and `Z`, which is what the pen
 * writes. Other paths (relative commands, arcs, quadratic curves) can still have their points
 * dragged (see points.ts), just not added or deleted.
 */

export interface Pt {
  x: number;
  y: number;
}

/** A pen node: the point, and its curve handles (none: a corner). */
export interface PenNode extends Pt {
  in?: Pt;
  out?: Pt;
}

/** Edge from one node to the next: a straight line, or a curve with both control points. */
interface Edge {
  c1?: Pt;
  c2?: Pt;
}

/** One subpath. Open: `edges.length === nodes.length - 1`; closed: equal (the last edge closes it). */
interface Sub {
  nodes: Pt[];
  edges: Edge[];
  closed: boolean;
}

const near = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const shift = (p: Pt, dx: number, dy: number): Pt => ({
  x: p.x + dx,
  y: p.y + dy,
});

/** Numbers written back: as they are, with at most 3 decimals. */
function num(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}

const pt = (p: Pt) => `${num(p.x)},${num(p.y)}`;

/**
 * Path text for pen nodes: `M 10,20 C 30,20 50,40 50,60 L 80,60 Z`. Between two nodes the
 * edge is a curve when either has a handle on that side, otherwise a line.
 */
export function penPathData(nodes: PenNode[], closed: boolean): string {
  if (nodes.length === 0) return "";
  const parts = [`M ${pt(nodes[0])}`];
  const edge = (a: PenNode, b: PenNode, last: boolean) => {
    if (a.out || b.in) parts.push(`C ${pt(a.out ?? a)} ${pt(b.in ?? b)} ${pt(b)}`);
    else if (!last) parts.push(`L ${pt(b)}`);
  };
  for (let i = 0; i + 1 < nodes.length; i++) edge(nodes[i], nodes[i + 1], false);
  if (closed && nodes.length > 1) {
    edge(nodes[nodes.length - 1], nodes[0], true);
    parts.push("Z");
  }
  return parts.join(" ");
}

/** Parses a simple path (see the top of this file), or null. */
function parseSimple(d: string): Sub[] | null {
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  const tokens: (string | number)[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    if (m[4]) return null;
    if (m[1]) tokens.push(m[1]);
    else if (m[2]) tokens.push(Number(m[2]));
  }
  const subs: Sub[] = [];
  let sub: Sub | null = null;
  let cur: Pt = { x: 0, y: 0 };
  let i = 0;
  const nums = (n: number): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = tokens[i + k];
      if (typeof t !== "number") return null;
      out.push(t);
    }
    i += n;
    return out;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (typeof cmd !== "string") return null;
    if (cmd !== "M" && sub?.closed) return null; // after Z only a new `M`
    switch (cmd) {
      case "M": {
        const a = nums(2);
        if (!a) return null;
        sub = { nodes: [{ x: a[0], y: a[1] }], edges: [], closed: false };
        subs.push(sub);
        cur = sub.nodes[0];
        // Further pairs after `M` are lines.
        while (typeof tokens[i] === "number") {
          const b = nums(2);
          if (!b) return null;
          cur = { x: b[0], y: b[1] };
          sub.nodes.push(cur);
          sub.edges.push({});
        }
        break;
      }
      case "L":
      case "H":
      case "V":
      case "C": {
        if (!sub) return null;
        const n = cmd === "C" ? 6 : cmd === "L" ? 2 : 1;
        if (typeof tokens[i] !== "number") return null;
        while (typeof tokens[i] === "number") {
          const a = nums(n);
          if (!a) return null;
          if (cmd === "C") {
            sub.edges.push({
              c1: { x: a[0], y: a[1] },
              c2: { x: a[2], y: a[3] },
            });
            cur = { x: a[4], y: a[5] };
          } else {
            sub.edges.push({});
            cur = cmd === "L" ? { x: a[0], y: a[1] } : cmd === "H" ? { x: a[0], y: cur.y } : { x: cur.x, y: a[0] };
          }
          sub.nodes.push(cur);
        }
        break;
      }
      case "Z": {
        if (!sub || sub.closed) return null;
        sub.closed = true;
        const n = sub.nodes;
        // An end written on the start point: that edge closes the path (no extra node).
        if (n.length > 1 && near(n[n.length - 1], n[0])) n.pop();
        else sub.edges.push({});
        cur = n[0];
        break;
      }
      default:
        return null;
    }
  }
  return subs.length > 0 ? subs : null;
}

function formatSimple(subs: Sub[]): string {
  const parts: string[] = [];
  for (const s of subs) {
    parts.push(`M ${pt(s.nodes[0])}`);
    const n = s.nodes.length;
    for (let i = 0; i < s.edges.length; i++) {
      const e = s.edges[i];
      const closing = s.closed && i === n - 1;
      const to = s.nodes[closing ? 0 : i + 1];
      if (e.c1 && e.c2) parts.push(`C ${pt(e.c1)} ${pt(e.c2)} ${pt(to)}`);
      else if (!closing) parts.push(`L ${pt(to)}`);
    }
    if (s.closed) parts.push("Z");
  }
  return parts.join(" ");
}

/** Whether points can be added to and deleted from this path text. */
export function isSimplePath(d: string): boolean {
  return parseSimple(d) !== null;
}

/** The two ends of edge `i` of a subpath. */
function ends(s: Sub, i: number): [Pt, Pt] {
  return [s.nodes[i], s.nodes[(i + 1) % s.nodes.length]];
}

/** The middle of an edge: on the curve (t = 0.5) for curves. */
function edgeMiddle(a: Pt, b: Pt, e: Edge): Pt {
  if (!e.c1 || !e.c2) return mid(a, b);
  return {
    x: (a.x + 3 * e.c1.x + 3 * e.c2.x + b.x) / 8,
    y: (a.y + 3 * e.c1.y + 3 * e.c2.y + b.y) / 8,
  };
}

/** The middle of each side (edge), in the path's own numbers; null for paths that are not simple. */
export function pathSides(d: string): Pt[] | null {
  const subs = parseSimple(d);
  if (!subs) return null;
  const out: Pt[] = [];
  for (const s of subs) s.edges.forEach((e, i) => out.push(edgeMiddle(...ends(s, i), e)));
  return out;
}

/** Finds global edge / node `index` in the subpaths. */
function locate(subs: Sub[], index: number, of: "edges" | "nodes"): { s: Sub; i: number; before: number } | null {
  let before = 0;
  for (const s of subs) {
    if (index < s[of].length) return { s, i: index, before };
    index -= s[of].length;
    before += s.nodes.length;
  }
  return null;
}

/**
 * Adds a node in the middle of side `side`, moved by (dx, dy) (it splits a curve into two
 * that draw the same shape). Returns the new text and the new node's index, or a reason.
 */
export function splitPathSide(d: string, side: number, dx: number, dy: number, round: (n: number) => number = (n) => n): { d: string; node: number } | string {
  const subs = parseSimple(d);
  const at = subs && locate(subs, side, "edges");
  if (!subs || !at) return "this side cannot be found in `d`";
  const { s, i } = at;
  const [a, b] = ends(s, i);
  const e = s.edges[i];
  const r = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });
  let first: Edge = {};
  let second: Edge = {};
  let m: Pt;
  if (e.c1 && e.c2) {
    // de Casteljau at t = 0.5
    const p01 = mid(a, e.c1);
    const p12 = mid(e.c1, e.c2);
    const p23 = mid(e.c2, b);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    m = mid(p012, p123);
    first = { c1: r(p01), c2: r(shift(p012, dx, dy)) };
    second = { c1: r(shift(p123, dx, dy)), c2: r(p23) };
  } else {
    m = mid(a, b);
  }
  s.nodes.splice(i + 1, 0, r(shift(m, dx, dy)));
  s.edges.splice(i, 1, first, second);
  return { d: formatSimple(subs), node: at.before + i + 1 };
}

/**
 * Deletes node `node`: the two sides around it become one (a curve keeps the outer control
 * points). A subpath keeps at least 2 nodes.
 */
export function deletePathNode(d: string, node: number): string | { error: string } {
  const subs = parseSimple(d);
  const at = subs && locate(subs, node, "nodes");
  if (!subs || !at) return { error: "this point cannot be found in `d`" };
  const { s, i } = at;
  const n = s.nodes.length;
  if (n <= 2)
    return {
      error: "a path needs at least 2 points, so this one cannot be deleted",
    };
  const merge = (inEdge: Edge, outEdge: Edge, from: Pt, to: Pt): Edge => (inEdge.c1 || outEdge.c2 ? { c1: inEdge.c1 ?? from, c2: outEdge.c2 ?? to } : {});
  if (!s.closed) {
    if (i === 0) s.edges.shift();
    else if (i === n - 1) s.edges.pop();
    else s.edges.splice(i - 1, 2, merge(s.edges[i - 1], s.edges[i], s.nodes[i - 1], s.nodes[i + 1]));
    s.nodes.splice(i, 1);
  } else {
    const prev = (i - 1 + n) % n;
    const merged = merge(s.edges[prev], s.edges[i], s.nodes[prev], s.nodes[(i + 1) % n]);
    if (i === 0) {
      // The next node becomes the start; the merged edge closes the path.
      s.edges = [...s.edges.slice(1, n - 1), merged];
    } else {
      s.edges.splice(prev, 2, merged);
    }
    s.nodes.splice(i, 1);
  }
  return formatSimple(subs);
}
