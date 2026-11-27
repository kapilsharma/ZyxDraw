// Adding, deleting and continuing points on paths written with any SVG command, in upper case
// (absolute) and lower case (relative) (issue #37). Only the segments an edit touches change,
// in their own case; a following segment is rewritten only when it would draw differently.
import { describe, expect, it } from "vitest";
import { applyEdits, canAddPoints, compile, continuePath, deletePoint, insertPoint, pointHandles, type PenNode, type Shape } from "../../src/core";

const CANVAS = "canvas(width=400, height=300)\n";
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const src = (d: string) => `${CANVAS}p is path(d="${d}", fill=none, stroke=black)\n`;
const dOf = (text: string) => /d="([^"]*)"/.exec(text)![1];

function target(text: string) {
  const r = compile(text);
  expect(r.diagnostics).toEqual([]);
  const shape = r.scene.roots.find((s: Shape) => s.path === "p")!;
  return { t: { source: text, scene: r.scene }, shape };
}

/** Adds a point in the middle of side `side`; returns the new `d`. */
function split(d: string, side: number): string {
  const { t } = target(src(d));
  const e = insertPoint(t, "p", side, 0, 0, fmt);
  expect(e.notices).toEqual([]);
  const out = applyEdits(t.source, e.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return dOf(out);
}

/** Deletes node `node` (counting only the points on the outline); returns the new `d`. */
function del(d: string, node: number): string {
  const { t, shape } = target(src(d));
  const ends = pointHandles(t.scene, shape)!.map((h, i) => (h.kind === "end" ? i : -1)).filter((i) => i >= 0);
  const e = deletePoint(t, "p", ends[node]);
  expect(e.notices).toEqual([]);
  const out = applyEdits(t.source, e.edits);
  expect(compile(out).diagnostics).toEqual([]);
  return dOf(out);
}

function cont(d: string, at: "start" | "end", nodes: PenNode[], close = false): string {
  const { t } = target(src(d));
  const e = continuePath(t, "p", at, nodes, close, fmt);
  expect(e.notices).toEqual([]);
  return dOf(applyEdits(t.source, e.edits));
}

describe("adding a point keeps each kind of side, and its case", () => {
  it("lines: L, H, V and the pairs after M", () => {
    expect(split("M 0 0 L 10 0", 0)).toBe("M 0 0 L 5 0 L 10 0");
    expect(split("M 0 0 l 10 0", 0)).toBe("M 0 0 l 5 0 l 5 0");
    expect(split("M 0 0 H 10", 0)).toBe("M 0 0 H 5 H 10");
    expect(split("M 0 0 h 10", 0)).toBe("M 0 0 h 5 h 5");
    expect(split("M 0 0 V 10", 0)).toBe("M 0 0 V 5 V 10");
    expect(split("M 0 0 v 10", 0)).toBe("M 0 0 v 5 v 5");
    // A pair written after `M` is a line; the pair after it gets its `L` back.
    expect(split("M 0 0 10 0 20 0", 0)).toBe("M 0 0 L 5 0 L 10 0 L 20 0");
  });

  it("cubic curves: C and c split in two with the same shape", () => {
    expect(split("M 0,0 C 0,10 10,10 10,0", 0)).toBe("M 0,0 C 0,5 2.5,7.5 5,7.5 C 7.5,7.5 10,5 10,0");
    expect(split("M 0,0 c 0,10 10,10 10,0", 0)).toBe("M 0,0 c 0,5 2.5,7.5 5,7.5 c 2.5,0 5,-2.5 5,-7.5");
  });

  it("smooth curves: the first half of an S gets its own handle (C), the second stays S", () => {
    expect(split("M 0,0 C 0,10 10,10 10,0 S 20,-10 20,0", 1)).toBe("M 0,0 C 0,10 10,10 10,0 C 10,-5 12.5,-7.5 15,-7.5 S 20,-5 20,0");
    expect(split("M 0,0 c 0,10 10,10 10,0 s 10,-10 10,0", 1)).toBe("M 0,0 c 0,10 10,10 10,0 c 0,-5 2.5,-7.5 5,-7.5 s 5,2.5 5,7.5");
  });

  it("an S after a split curve would mirror a new handle: it becomes C, drawing as before", () => {
    expect(split("M 0,0 C 0,10 10,10 10,0 S 20,-10 20,0", 0)).toBe("M 0,0 C 0,5 2.5,7.5 5,7.5 C 7.5,7.5 10,5 10,0 C 10,-10 20,-10 20,0");
    expect(split("M 0,0 c 0,10 10,10 10,0 s 10,-10 10,0", 0)).toBe("M 0,0 c 0,5 2.5,7.5 5,7.5 c 2.5,0 5,-2.5 5,-7.5 c 0,-10 10,-10 10,0");
  });

  it("quadratic curves: Q, q, and T (which becomes Q, and keeps a following T as it was)", () => {
    expect(split("M 0,0 Q 10,10 20,0", 0)).toBe("M 0,0 Q 5,5 10,5 Q 15,5 20,0");
    expect(split("M 0,0 q 10,10 20,0", 0)).toBe("M 0,0 q 5,5 10,5 q 5,0 10,-5");
    expect(split("M 0,0 Q 10,10 20,0 T 40,0", 1)).toBe("M 0,0 Q 10,10 20,0 Q 25,-5 30,-5 Q 35,-5 40,0");
    expect(split("M 0,0 Q 10,10 20,0 T 40,0", 0)).toBe("M 0,0 Q 5,5 10,5 Q 15,5 20,0 Q 30,-10 40,0");
    expect(split("M 0,0 q 10,10 20,0 t 20,0", 0)).toBe("M 0,0 q 5,5 10,5 q 5,0 10,-5 q 10,-10 20,0");
  });

  it("arcs: A and a split at the middle of the arc", () => {
    expect(split("M 0,0 A 10 10 0 0 1 20,0", 0)).toBe("M 0,0 A 10 10 0 0 1 10,-10 A 10 10 0 0 1 20,0");
    expect(split("M 0,0 a 10 10 0 0 1 20,0", 0)).toBe("M 0,0 a 10 10 0 0 1 10,-10 a 10 10 0 0 1 10,10");
  });

  it("the line drawn by Z / z", () => {
    expect(split("M 0,0 L 40,0 L 40,40 Z", 2)).toBe("M 0,0 L 40,0 L 40,40 L 20,20 Z");
    expect(split("M 0,0 l 40,0 l 0,40 z", 2)).toBe("M 0,0 l 40,0 l 0,40 l -20,-20 z");
  });

  it("a relative path after the split side stays as written", () => {
    expect(split("m 0 0 l 10 0 l 0 10 l 10 0", 0)).toBe("m 0 0 l 5 0 l 5 0 l 0 10 l 10 0");
  });
});

describe("deleting a point", () => {
  it("joins two relative lines into one, and leaves the rest", () => {
    expect(del("M 0 0 l 10 0 l 0 10 l 10 0", 1)).toBe("M 0 0 l 10 10 l 10 0");
  });

  it("removes the last point, and the first (the next one becomes `m`)", () => {
    expect(del("M 0 0 l 10 0 l 0 10", 2)).toBe("M 0 0 l 10 0");
    expect(del("m 5 5 l 10 0 l 0 10", 0)).toBe("m 15 5 l 0 10");
  });

  it("keeps an S drawing as before when the curve it mirrored goes", () => {
    expect(del("M 0,0 C 0,10 10,10 10,0 S 20,-10 20,0 L 30,0", 0)).toBe("M 10,0 C 10,-10 20,-10 20,0 L 30,0");
    // Its mirrored handle is the same as before: left as written.
    expect(del("M 0,0 L 10,0 C 10,10 20,10 20,0 S 30,-10 30,0", 1)).toBe("M 0,0 C 0,0 20,10 20,0 S 30,-10 30,0");
  });

  it("joins two arcs into one", () => {
    expect(del("M 0,0 A 10 10 0 0 1 10,-10 A 10 10 0 0 1 20,0 L 30,0", 1)).toBe("M 0,0 A 10 10 0 0 1 20,0 L 30,0");
  });

  it("joins quadratic curves into a cubic one", () => {
    expect(del("M 0,0 Q 5,5 10,5 Q 15,5 20,0", 1)).toBe("M 0,0 C 3.333,3.333 16.667,3.333 20,0");
  });

  it("deletes the start of a closed relative path", () => {
    expect(del("m 0 0 l 40 0 l 0 40 l -40 0 z", 0)).toBe("m 40 0 l 0 40 l -40 0 z");
  });
});

describe("continuing", () => {
  it("adds to a relative path", () => {
    expect(cont("M 0 0 l 10 0", "end", [{ x: 10, y: 0 }, { x: 10, y: 10 }])).toBe("M 0 0 l 10 0 L 10,10");
    expect(cont("m 10 10 l 10 0", "start", [{ x: 10, y: 10 }, { x: 0, y: 10 }])).toBe("M 0,10 L 10,10 l 10 0");
  });

  it("keeps an S after the old start drawing as before", () => {
    expect(cont("M 0,0 S 10,10 20,0", "start", [{ x: 0, y: 0, out: { x: -5, y: 5 } }, { x: -20, y: 0 }])).toBe("M -20,0 C -20,0 -5,5 0,0 C 0,0 10,10 20,0");
  });

  it("continues paths with arcs and quadratic curves", () => {
    expect(cont("M 0,0 A 10 10 0 0 1 20,0", "end", [{ x: 20, y: 0 }, { x: 30, y: 0 }])).toBe("M 0,0 A 10 10 0 0 1 20,0 L 30,0");
    expect(cont("M 0,0 q 10,10 20,0", "start", [{ x: 0, y: 0 }, { x: 0, y: 20 }], true)).toBe("M 0,20 L 0,0 q 10,10 20,0 Z");
  });
});

describe("every command, in both cases", () => {
  const PATHS = [
    "M 0,0 L 20,0 L 20,20",
    "M 0,0 H 20 V 20 H 40",
    "M 0,0 C 0,20 20,20 20,0 S 40,-20 40,0",
    "M 0,0 Q 10,20 20,0 T 40,0 T 60,0",
    "M 0,0 A 10 10 0 0 1 20,0 A 10 10 0 0 0 40,0",
    "M 0,0 L 20,0 L 20,20 Z",
  ];
  const lower = (d: string) => d.toLowerCase().replace(/^m/, "M");
  const nodes = (d: string) => {
    const { t, shape } = target(src(d));
    return pointHandles(t.scene, shape)!.filter((h) => h.kind === "end").length;
  };

  for (const d of [...PATHS, ...PATHS.map(lower)]) {
    it(`adds a point on every side and deletes every point: ${d}`, () => {
      const { t, shape } = target(src(d));
      expect(canAddPoints(shape)).toBe(true);
      const n = nodes(d);
      const sides = pointHandles(t.scene, shape)!.length > 0 ? (d.includes("Z") || d.includes("z") ? n : n - 1) : 0;
      const relative = d !== lower(d) ? false : true;
      for (let side = 0; side < sides; side++) {
        const out = split(d, side);
        expect(nodes(out), `side ${side}`).toBe(n + 1);
        // A relative path stays relative: no new upper-case command after the first `M`.
        if (relative) expect(out.slice(1), `side ${side}`).toBe(out.slice(1).toLowerCase());
      }
      for (let node = 0; node < n && n > 2; node++) {
        const out = del(d, node);
        expect(nodes(out), `node ${node}`).toBe(n - 1);
        if (relative) expect(out.slice(1), `node ${node}`).toBe(out.slice(1).toLowerCase());
      }
    });
  }
});
