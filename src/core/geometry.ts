/** Helpers for `points` (polyline, polygon) and `d` (path). Pure functions. */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------------------------
// points="20,20 100,80"

export function parsePoints(text: string, minPoints: number): Parsed<number[]> {
  const parts = text.trim().split(/[\s,]+/).filter((p) => p.length > 0);
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) return { ok: false, error: "`points` must contain only numbers" };
  if (nums.length % 2 !== 0) return { ok: false, error: "`points` has an odd number of values (each point needs x and y)" };
  if (nums.length / 2 < minPoints) return { ok: false, error: `At least ${minPoints} points are needed` };
  return { ok: true, value: nums };
}

export function pointsBounds(nums: number[]): Bounds {
  const b = emptyBounds();
  for (let i = 0; i < nums.length; i += 2) extend(b, nums[i], nums[i + 1]);
  return b;
}

export function formatPoints(nums: number[], dx: number, dy: number, fmt: (n: number) => string): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length; i += 2) out.push(`${fmt(nums[i] + dx)},${fmt(nums[i + 1] + dy)}`);
  return out.join(" ");
}

/**
 * Path data for points with rounded corners (`polygon(radius=...)`). Each corner is cut back by
 * `radius` along both edges (at most half of each edge) and joined with a curve whose control
 * point is the corner itself. A polyline keeps its two ends sharp.
 */
export function roundedPointsPath(nums: number[], closed: boolean, radius: number, dx: number, dy: number, fmt: (n: number) => string): string {
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i] + dx, nums[i + 1] + dy]);
  const n = pts.length;
  const p = (q: [number, number]) => `${fmt(q[0])} ${fmt(q[1])}`;
  /** Point `cut` away from `from` toward `to`. */
  const toward = (from: [number, number], to: [number, number], cut: number): [number, number] => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return len === 0 ? from : [from[0] + ((to[0] - from[0]) * cut) / len, from[1] + ((to[1] - from[1]) * cut) / len];
  };
  const corner = (i: number): string => {
    const c = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const cut = Math.min(radius, Math.hypot(prev[0] - c[0], prev[1] - c[1]) / 2, Math.hypot(next[0] - c[0], next[1] - c[1]) / 2);
    return `L ${p(toward(c, prev, cut))} Q ${p(c)} ${p(toward(c, next, cut))}`;
  };
  if (closed) {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(corner(i));
    return `M${parts.join(" ").slice(1)} Z`; // the first `L` becomes `M`
  }
  const parts = [`M ${p(pts[0])}`];
  for (let i = 1; i < n - 1; i++) parts.push(corner(i));
  parts.push(`L ${p(pts[n - 1])}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------
// d="M 20 20 L 180 20 Z"

export interface PathCommand {
  cmd: string;
  args: number[];
}

const ARG_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

export function parsePath(d: string): Parsed<PathCommand[]> {
  const tokenRe = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([\s,]+)|(.)/g;
  const commands: PathCommand[] = [];
  let current: PathCommand | null = null;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(d)) !== null) {
    if (m[3]) continue;
    if (m[4]) return { ok: false, error: `Unexpected \`${m[4]}\` in path data` };
    if (m[1]) {
      const upper = m[1].toUpperCase();
      if (!(upper in ARG_COUNT)) return { ok: false, error: `Unknown path command \`${m[1]}\`` };
      if (commands.length === 0 && upper !== "M") return { ok: false, error: "Path data must start with `M` (move to)" };
      current = { cmd: m[1], args: [] };
      commands.push(current);
      continue;
    }
    if (!current) return { ok: false, error: "Path data must start with `M` (move to)" };
    current.args.push(Number(m[2]));
  }
  if (commands.length === 0) return { ok: false, error: "Path data is empty" };
  for (const c of commands) {
    const n = ARG_COUNT[c.cmd.toUpperCase()];
    if (n === 0 ? c.args.length !== 0 : c.args.length === 0 || c.args.length % n !== 0) {
      return { ok: false, error: `\`${c.cmd}\` needs ${n === 0 ? "no" : n} values${n > 1 ? " (or a multiple)" : ""}` };
    }
  }
  return { ok: true, value: commands };
}

/** Moves a path by (dx, dy). Only absolute (uppercase) coordinates change, plus a leading `m`. */
export function offsetPath(commands: PathCommand[], dx: number, dy: number): PathCommand[] {
  return commands.map((c, index) => {
    const upper = c.cmd.toUpperCase();
    const absolute = c.cmd === upper || (index === 0 && c.cmd === "m");
    if (!absolute) return c;
    const n = ARG_COUNT[upper];
    const args = c.args.slice();
    for (let i = 0; i < args.length; i++) {
      const k = i % n;
      if (upper === "H") args[i] += dx;
      else if (upper === "V") args[i] += dy;
      else if (upper === "A") {
        if (k === 5) args[i] += dx;
        else if (k === 6) args[i] += dy;
      } else if (index === 0 && c.cmd === "m" && i >= 2) {
        // After the first pair, `m` continues as relative line-to: unchanged.
      } else {
        args[i] += k % 2 === 0 ? dx : dy;
      }
    }
    return { cmd: c.cmd, args };
  });
}

export function formatPath(commands: PathCommand[], fmt: (n: number) => string): string {
  return commands.map((c) => (c.args.length ? `${c.cmd} ${c.args.map(fmt).join(" ")}` : c.cmd)).join(" ");
}

/** Approximate bounds: end points and control points (good enough for anchoring). */
export function pathBounds(commands: PathCommand[]): Bounds {
  const b = emptyBounds();
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  for (const c of commands) {
    const upper = c.cmd.toUpperCase();
    const rel = c.cmd !== upper;
    const n = ARG_COUNT[upper];
    if (upper === "Z") {
      cx = sx;
      cy = sy;
      continue;
    }
    for (let i = 0; i < c.args.length; i += n) {
      const a = c.args.slice(i, i + n);
      const ox = rel ? cx : 0;
      const oy = rel ? cy : 0;
      if (upper === "H") {
        cx = a[0] + ox;
      } else if (upper === "V") {
        cy = a[0] + oy;
      } else if (upper === "A") {
        cx = a[5] + ox;
        cy = a[6] + oy;
      } else {
        for (let k = 0; k < a.length - 2; k += 2) extend(b, a[k] + ox, a[k + 1] + oy);
        cx = a[a.length - 2] + ox;
        cy = a[a.length - 1] + oy;
      }
      extend(b, cx, cy);
      if (upper === "M" && i === 0) {
        sx = cx;
        sy = cy;
      }
    }
  }
  return b;
}

function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function extend(b: Bounds, x: number, y: number): void {
  b.minX = Math.min(b.minX, x);
  b.minY = Math.min(b.minY, y);
  b.maxX = Math.max(b.maxX, x);
  b.maxY = Math.max(b.maxY, y);
}
